// ST-Background-Reply — server plugin
// Keeps chat generation requests alive on the server, independent of the browser tab.
// The browser sends the generation request to /api/plugins/st-bg-reply/start instead of
// SillyTavern's own endpoint; this plugin replays it to SillyTavern over loopback (with the
// same cookie / CSRF token / basic auth), streams the reply back to the browser while also
// writing it to disk, and does NOT abort when the browser disconnects (reload, chat switch,
// phone sleep). The extension later fetches the stored reply and puts it into the chat.
//
// Installed by the extension's installer into SillyTavern/plugins/st-bg-reply/.
// Requires `enableServerPlugins: true` in config.yaml.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

export const VERSION = '1.0.0';
export const PROTOCOL = 1;

export const info = {
    id: 'st-bg-reply',
    name: 'Background Reply',
    description: 'Runs chat generations in the background so replies survive page reloads, chat switches and phone sleep. Companion plugin of the ST-Background-Reply extension.',
};

const ALLOWED_TARGETS = new Set([
    '/api/backends/chat-completions/generate',
    '/api/backends/text-completions/generate',
]);
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;      // finished jobs are deleted after 7 days
const MEMORY_KEEP_MS = 2 * 60 * 1000;          // raw bytes stay in memory 2 min after finishing
const MAX_RAW_BYTES = 64 * 1024 * 1024;        // safety cap per job
const CLAIM_MS = 60 * 1000;
const JOB_DIR_NAME = 'bg-reply-jobs';

/** @type {Map<string, any>} key = `${dir}|${id}` */
const active = new Map();

function log(...args) {
    console.log('[st-bg-reply]', ...args);
}

function jobDir(req) {
    const root = req.user?.directories?.root || path.join(process.cwd(), 'data', 'default-user');
    const dir = path.join(root, JOB_DIR_NAME);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function jsonPath(dir, id) { return path.join(dir, `${id}.json`); }
function rawPath(dir, id) { return path.join(dir, `${id}.raw`); }

function publicInfo(job) {
    return {
        id: job.id,
        status: job.status,
        httpStatus: job.httpStatus ?? null,
        error: job.error ?? null,
        bytes: job.bytes ?? 0,
        delivered: !!job.delivered,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        finishedAt: job.finishedAt ?? null,
        meta: job.meta ?? null,
        local: job.local ?? {},
    };
}

function persist(job) {
    if (job.removed) return;
    try {
        job.updatedAt = Date.now();
        fs.writeFileSync(jsonPath(job.dir, job.id), JSON.stringify(publicInfo(job)));
    } catch (error) {
        log('persist failed', job.id, error?.message);
    }
}

let persistTimers = new Map();
function persistSoon(job) {
    if (persistTimers.has(job)) return;
    persistTimers.set(job, setTimeout(() => {
        persistTimers.delete(job);
        persist(job);
    }, 1500));
}

function readStored(dir, id) {
    try {
        return JSON.parse(fs.readFileSync(jsonPath(dir, id), 'utf8'));
    } catch {
        return null;
    }
}

function getJob(dir, id) {
    const mem = active.get(`${dir}|${id}`);
    if (mem) return mem;
    const stored = readStored(dir, id);
    if (!stored) return null;
    return { ...stored, dir, inMemory: false };
}

function deleteFiles(dir, id) {
    for (const file of [jsonPath(dir, id), rawPath(dir, id)]) {
        try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    }
}

function loopbackHosts(req) {
    const local = String(req.socket?.localAddress || '');
    const mapped = local.startsWith('::ffff:') ? local.slice(7) : local;
    const isV4 = mapped.includes('.');
    const list = isV4 ? ['127.0.0.1', '::1'] : ['::1', '127.0.0.1'];
    if (mapped && !list.includes(mapped)) list.push(mapped);
    return list;
}

function pickHeaders(req, length) {
    const headers = {
        'content-type': 'application/json',
        'content-length': String(length),
        'accept': req.headers['accept'] || '*/*',
    };
    for (const name of ['cookie', 'x-csrf-token', 'authorization', 'host', 'user-agent', 'accept-language']) {
        if (req.headers[name]) headers[name] = req.headers[name];
    }
    return headers;
}

function finish(job, status, error = null) {
    if (job.finished) return;
    job.finished = true;
    job.status = status;
    if (error) job.error = String(error).slice(0, 4000);
    job.finishedAt = Date.now();
    let called = false;
    const done = () => {
        if (called) return;
        called = true;
        persist(job);
        for (const follower of job.followers) {
            try { follower.end(); } catch { /* ignore */ }
        }
        job.followers.clear();
        setTimeout(() => {
            job.chunks = null;
            active.delete(`${job.dir}|${job.id}`);
        }, MEMORY_KEEP_MS).unref?.();
    };
    if (job.rawStream && !job.rawStream.destroyed) {
        job.rawStream.end(done);
        setTimeout(done, 3000).unref?.();
    } else {
        done();
    }
}

function startUpstream(req, job, payload) {
    const hosts = loopbackHosts(req);
    const port = req.socket?.localPort;
    const secure = !!req.socket?.encrypted;
    const transport = secure ? https : http;
    const headers = pickHeaders(req, payload.length);

    const attempt = (index) => {
        const host = hosts[index];
        const upReq = transport.request({
            host,
            port,
            method: 'POST',
            path: job.target,
            headers,
            agent: false,
            rejectUnauthorized: false, // loopback to our own (possibly self-signed) server
        });
        job.upReq = upReq;

        upReq.on('response', (upRes) => onUpstreamResponse(job, upRes));
        upReq.on('error', (error) => {
            if (job.abortRequested) {
                finish(job, 'aborted');
                closeClient(job);
                return;
            }
            const code = error?.code;
            if (!job.gotResponse && ['ECONNREFUSED', 'EADDRNOTAVAIL', 'EAFNOSUPPORT', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code) && index + 1 < hosts.length) {
                attempt(index + 1);
                return;
            }
            log('upstream error', job.id, code || error?.message);
            if (!job.gotResponse && job.clientOpen && !job.res.headersSent) {
                try {
                    job.res.statusCode = 502;
                    job.res.setHeader('content-type', 'text/plain; charset=utf-8');
                    job.res.setHeader('x-bgr-job', job.id);
                    job.res.setHeader('x-bgr-error', 'loopback');
                    job.res.end(`Background Reply plugin could not reach SillyTavern over loopback: ${code || error?.message}`);
                } catch { /* ignore */ }
            }
            finish(job, 'error', code || error?.message || 'upstream error');
            closeClient(job);
        });
        upReq.end(payload);
    };

    attempt(0);
}

function onUpstreamResponse(job, upRes) {
    job.gotResponse = true;
    job.upRes = upRes;
    job.httpStatus = upRes.statusCode;
    const contentType = upRes.headers['content-type'] || 'application/octet-stream';
    job.contentType = contentType;
    const ok = upRes.statusCode >= 200 && upRes.statusCode < 300;
    const errorChunks = [];

    if (job.clientOpen) {
        try {
            const res = job.res;
            res.statusCode = upRes.statusCode;
            if (upRes.statusMessage) res.statusMessage = upRes.statusMessage;
            res.setHeader('content-type', contentType);
            res.setHeader('cache-control', 'no-cache, no-transform');
            res.setHeader('x-accel-buffering', 'no');
            res.setHeader('x-bgr-job', job.id);
            res.flushHeaders?.();
        } catch { /* ignore */ }
    }
    persist(job);

    upRes.on('data', (chunk) => {
        if (!ok && errorChunks.length < 64) errorChunks.push(chunk);
        job.bytes += chunk.length;
        if (job.chunks) job.chunks.push(chunk);
        job.rawStream?.write(chunk);
        if (job.clientOpen) {
            try {
                job.res.write(chunk);
                job.res.flush?.();
            } catch { /* client went away */ }
        }
        for (const follower of job.followers) {
            try { follower.write(chunk); follower.flush?.(); } catch { /* ignore */ }
        }
        if (job.bytes > MAX_RAW_BYTES) {
            job.abortRequested = true;
            job.error = 'Reply exceeded the size limit of the background plugin.';
            upReq_destroy(job);
        }
        persistSoon(job);
    });

    upRes.on('end', () => {
        const status = job.abortRequested ? 'aborted' : (ok ? 'done' : 'error');
        const errorText = ok ? null : Buffer.concat(errorChunks).toString('utf8') || `HTTP ${upRes.statusCode}`;
        finish(job, status, errorText);
        if (job.clientOpen) {
            try {
                job.res.on('finish', () => {
                    job.delivered = true;
                    persist(job);
                });
                job.res.end();
            } catch { /* ignore */ }
        }
    });

    upRes.on('error', (error) => {
        finish(job, job.abortRequested ? 'aborted' : 'error', error?.message || 'stream error');
        closeClient(job);
    });

    upRes.on('aborted', () => {
        finish(job, job.abortRequested ? 'aborted' : 'error', 'upstream aborted');
        closeClient(job);
    });
}

function upReq_destroy(job) {
    try { job.upReq?.destroy(); } catch { /* ignore */ }
    try { job.upRes?.destroy(); } catch { /* ignore */ }
}

function closeClient(job) {
    if (!job.clientOpen) return;
    job.clientOpen = false;
    try { job.res.end(); } catch { /* ignore */ }
}

function listJobs(dir) {
    const out = [];
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return out; }
    const now = Date.now();
    for (const file of files) {
        const id = file.slice(0, -5);
        const mem = active.get(`${dir}|${id}`);
        if (mem) {
            out.push(publicInfo(mem));
            continue;
        }
        const stored = readStored(dir, id);
        if (!stored) continue;
        if (stored.status === 'running') {
            // The server was restarted while this job was running.
            stored.status = 'interrupted';
            stored.finishedAt = stored.finishedAt || now;
            stored.error = stored.error || 'SillyTavern server restarted while the reply was being generated.';
            try { fs.writeFileSync(jsonPath(dir, id), JSON.stringify(stored)); } catch { /* ignore */ }
        }
        const age = now - (stored.finishedAt || stored.createdAt || now);
        if (age > KEEP_MS) {
            deleteFiles(dir, id);
            continue;
        }
        out.push(stored);
    }
    out.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    return out;
}

function sendRaw(job, from, follow, res) {
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('x-accel-buffering', 'no');
    res.setHeader('x-bgr-status', job.status);
    res.setHeader('x-bgr-bytes', String(job.bytes || 0));

    if (job.inMemory !== false && job.chunks) {
        const all = Buffer.concat(job.chunks);
        res.statusCode = 200;
        if (from < all.length) res.write(all.subarray(from));
        if (follow && !job.finished) {
            res.flush?.();
            job.followers.add(res);
            res.on('close', () => job.followers.delete(res));
            return;
        }
        res.end();
        return;
    }

    const file = rawPath(job.dir, job.id);
    if (!fs.existsSync(file)) {
        res.statusCode = 200;
        res.end();
        return;
    }
    const size = fs.statSync(file).size;
    res.statusCode = 200;
    if (from >= size) {
        res.end();
        return;
    }
    fs.createReadStream(file, { start: from }).pipe(res);
}

/**
 * @param {import('express').Router} router
 */
export async function init(router) {
    router.get('/ping', (_req, res) => {
        res.json({ ok: true, version: VERSION, protocol: PROTOCOL });
    });

    router.post('/start', (req, res) => {
        const id = String(req.query?.id || '');
        const target = String(req.query?.url || '');
        if (!ID_RE.test(id)) return res.status(400).send('Invalid job id');
        if (!ALLOWED_TARGETS.has(target)) return res.status(400).send('Target not allowed');

        let dir;
        try { dir = jobDir(req); } catch (error) { return res.status(500).send(String(error?.message || error)); }
        if (active.has(`${dir}|${id}`) || fs.existsSync(jsonPath(dir, id))) return res.status(409).send('Duplicate job id');

        const body = (req.body && typeof req.body === 'object') ? req.body : {};
        const meta = body.__bgrMeta ?? null;
        delete body.__bgrMeta;
        const payload = Buffer.from(JSON.stringify(body), 'utf8');

        const now = Date.now();
        const job = {
            id,
            dir,
            target,
            meta,
            local: {},
            status: 'running',
            createdAt: now,
            updatedAt: now,
            finishedAt: null,
            bytes: 0,
            chunks: [],
            followers: new Set(),
            res,
            clientOpen: true,
            delivered: false,
            finished: false,
            inMemory: true,
            rawStream: fs.createWriteStream(rawPath(dir, id), { flags: 'w' }),
        };
        job.rawStream.on('error', (error) => log('raw write failed', id, error?.message));
        active.set(`${dir}|${id}`, job);
        persist(job);

        // The browser going away must NOT stop the generation.
        res.on('close', () => {
            if (!res.writableFinished) job.clientOpen = false;
        });

        startUpstream(req, job, payload);
    });

    router.get('/jobs', (req, res) => {
        try {
            res.json({ version: VERSION, protocol: PROTOCOL, jobs: listJobs(jobDir(req)) });
        } catch (error) {
            res.status(500).send(String(error?.message || error));
        }
    });

    router.get('/raw/:id', (req, res) => {
        const id = String(req.params.id || '');
        if (!ID_RE.test(id)) return res.status(400).send('Invalid job id');
        const job = getJob(jobDir(req), id);
        if (!job) return res.status(404).send('Not found');
        const from = Math.max(0, Number(req.query?.from) || 0);
        const follow = String(req.query?.follow || '') === '1';
        sendRaw(job, from, follow, res);
    });

    router.post('/patch/:id', (req, res) => {
        const id = String(req.params.id || '');
        if (!ID_RE.test(id)) return res.status(400).send('Invalid job id');
        const dir = jobDir(req);
        const job = getJob(dir, id);
        if (!job) return res.status(404).send('Not found');
        const patch = req.body?.local;
        if (patch && typeof patch === 'object') {
            job.local = { ...(job.local || {}), ...patch };
        }
        if (job.inMemory === false) {
            try { fs.writeFileSync(jsonPath(dir, id), JSON.stringify(publicInfo(job))); } catch { /* ignore */ }
        } else {
            persist(job);
        }
        res.json(publicInfo(job));
    });

    router.post('/claim/:id', (req, res) => {
        const id = String(req.params.id || '');
        if (!ID_RE.test(id)) return res.status(400).send('Invalid job id');
        const dir = jobDir(req);
        const job = getJob(dir, id);
        if (!job) return res.status(404).send('Not found');
        const owner = String(req.body?.owner || '');
        const claim = job.local?.claim;
        if (claim && claim.owner !== owner && Date.now() - (claim.at || 0) < CLAIM_MS) {
            return res.status(409).json({ claimedBy: claim.owner });
        }
        job.local = { ...(job.local || {}), claim: { owner, at: Date.now() } };
        if (job.inMemory === false) {
            try { fs.writeFileSync(jsonPath(dir, id), JSON.stringify(publicInfo(job))); } catch { /* ignore */ }
        } else {
            persist(job);
        }
        res.json({ ok: true });
    });

    router.post('/abort/:id', (req, res) => {
        const id = String(req.params.id || '');
        if (!ID_RE.test(id)) return res.status(400).send('Invalid job id');
        const job = active.get(`${jobDir(req)}|${id}`);
        if (job && !job.finished) {
            job.abortRequested = true;
            upReq_destroy(job);
            finish(job, 'aborted');
            closeClient(job);
        }
        res.json({ ok: true });
    });

    router.post('/remove/:id', (req, res) => {
        const id = String(req.params.id || '');
        if (!ID_RE.test(id)) return res.status(400).send('Invalid job id');
        const dir = jobDir(req);
        const key = `${dir}|${id}`;
        const job = active.get(key);
        if (job) {
            job.removed = true; // nothing may write this job's files any more
            if (!job.finished) {
                job.abortRequested = true;
                upReq_destroy(job);
                closeClient(job);
            }
            job.finished = true;
            for (const follower of job.followers) {
                try { follower.end(); } catch { /* ignore */ }
            }
            active.delete(key);
            try { job.rawStream?.destroy(); } catch { /* ignore */ }
        }
        deleteFiles(dir, id);
        setTimeout(() => deleteFiles(dir, id), 500).unref?.();
        res.json({ ok: true });
    });

    log(`v${VERSION} loaded (protocol ${PROTOCOL})`);
}

export async function exit() {
    for (const job of active.values()) {
        if (!job.finished) {
            job.finished = true; // keep 'interrupted' even if the upstream socket reports an error while closing
            job.status = 'interrupted';
            job.error = 'SillyTavern server stopped while the reply was being generated.';
            job.finishedAt = Date.now();
            try { fs.writeFileSync(jsonPath(job.dir, job.id), JSON.stringify(publicInfo(job))); } catch { /* ignore */ }
            upReq_destroy(job);
        }
    }
}

export default { info, init, exit };
