// Two ways to run a generation in the background:
//  - plugin: the server plugin holds the request (survives reloads, closing the tab, phone sleep)
//  - local:  this tab holds the request (survives chat switches only; a reload keeps the partial text)

import { getRequestHeaders } from '../../../../../script.js';
import {
    PLUGIN_BASE, PLUGIN_PROTOCOL, TAB_ID, baseFetch, delay, log, warn, abortError,
} from './utils.js';
import { allJobs, emitChange, forgetJob, getJob, isFinished, upsertFromInfo } from './jobs.js';
import { storeAll, storeDelete, storePut } from './store.js';

export const backend = {
    /** @type {'detecting'|'plugin'|'local'} */
    mode: 'detecting',
    /** @type {{version: string, protocol: number}|null} */
    plugin: null,
    /** Last problem seen with the plugin (shown in the settings panel). */
    pluginError: null,
};

let hooks = {
    onProgress: (_job) => { },
    onFinished: (_job) => { },
};

export function setBackendHooks(next) {
    hooks = { ...hooks, ...next };
}

// ---------------------------------------------------------------------------
// Detection

export async function detectBackend() {
    try {
        const response = await baseFetch(`${PLUGIN_BASE}/ping`, { headers: getRequestHeaders(), cache: 'no-cache' });
        if (response.ok) {
            const info = await response.json();
            backend.plugin = { version: String(info.version ?? '?'), protocol: Number(info.protocol ?? 0) };
            if (backend.plugin.protocol !== PLUGIN_PROTOCOL) {
                backend.pluginError = 'protocol';
                backend.mode = 'local';
            } else {
                backend.pluginError = null;
                backend.mode = 'plugin';
            }
        } else {
            backend.plugin = null;
            backend.mode = 'local';
        }
    } catch {
        backend.plugin = null;
        backend.mode = 'local';
    }
    log('mode:', backend.mode, backend.plugin ? `plugin v${backend.plugin.version}` : '');
    await loadLocalJobs(); // leftovers of browser-only jobs (also after the plugin got installed)
    emitChange();
    return backend.mode;
}

// ---------------------------------------------------------------------------
// Starting a job. Returns the Response that SillyTavern will read.

/**
 * @param {any} job
 * @param {string} url Generation endpoint path
 * @param {RequestInit} init The request SillyTavern wanted to send (marker already removed from body)
 * @returns {Promise<Response>}
 */
export async function startJob(job, url, init) {
    if (backend.mode === 'plugin') {
        job.via = 'plugin';
        return await pluginStart(job, url, init);
    }
    job.via = 'local';
    return await localStart(job, url, init);
}

function serverRemove(id) {
    return baseFetch(`${PLUGIN_BASE}/remove/${id}`, { method: 'POST', headers: getRequestHeaders(), body: '{}' }).catch(() => { });
}

function withMeta(body, meta) {
    const text = String(body);
    const end = text.lastIndexOf('}');
    if (end < 0) return text;
    const inner = text.slice(0, end).trimEnd();
    const sep = inner.endsWith('{') ? '' : ',';
    return `${inner}${sep}"__bgrMeta":${JSON.stringify(meta)}}`;
}

async function pluginStart(job, url, init) {
    const stSignal = init.signal ?? null;
    // If ST aborts while waiting for the first byte, this throws AbortError for ST,
    // but the plugin keeps the generation running.
    const response = await baseFetch(`${PLUGIN_BASE}/start?id=${encodeURIComponent(job.id)}&url=${encodeURIComponent(url)}`, {
        method: 'POST',
        headers: init.headers,
        body: withMeta(init.body, job.meta),
        signal: stSignal,
        cache: 'no-cache',
    });

    const isOurs = !!response.headers.get('x-bgr-job');
    if (!isOurs) {
        // Plugin route missing (not installed / disabled) or refused the job: send the request the normal way.
        warn('plugin did not take the job, falling back', response.status);
        if (response.status === 404) {
            backend.mode = 'local';
            backend.plugin = null;
            emitChange();
            job.via = 'local';
            return await localStart(job, url, init);
        }
        forgetJob(job.id);
        return await baseFetch(url, init);
    }

    if (response.status === 502 && response.headers.get('x-bgr-error') === 'loopback') {
        // The plugin could not reach SillyTavern over loopback. Run this one in the tab instead.
        backend.pluginError = 'loopback';
        emitChange();
        serverRemove(job.id);
        job.via = 'local';
        job.status = 'running';
        job.error = null;
        return await localStart(job, url, init);
    }

    job.httpStatus = response.status;
    if (!response.ok) {
        // ST shows the API error itself. Nothing to keep.
        job.status = 'error';
        job.handledByST = true;
        setTimeout(() => removeJob(job).catch(() => { }), 1500);
        return response;
    }

    return new Response(resumableBody(job, response.body, stSignal), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    });
}

/**
 * Body for SillyTavern that resumes from the plugin's stored copy if the connection drops
 * (e.g. a phone network change), so ST keeps streaming instead of failing.
 */
function resumableBody(job, body, stSignal) {
    let reader = body.getReader();
    let offset = 0;
    let attempts = 0;
    return new ReadableStream({
        async pull(controller) {
            for (; ;) {
                try {
                    const { done, value } = await reader.read();
                    if (done) {
                        job.stEof = true;
                        controller.close();
                        return;
                    }
                    offset += value.byteLength;
                    attempts = 0;
                    controller.enqueue(value);
                    return;
                } catch (error) {
                    if (stSignal?.aborted || job.detachRequested) {
                        controller.error(error);
                        return;
                    }
                    if (++attempts > 8) {
                        job.stFailed = true;
                        controller.error(error);
                        return;
                    }
                    await delay(Math.min(500 * attempts, 3000));
                    if (stSignal?.aborted) {
                        controller.error(abortError());
                        return;
                    }
                    try {
                        const resumed = await baseFetch(`${PLUGIN_BASE}/raw/${job.id}?from=${offset}&follow=1`, {
                            headers: getRequestHeaders(),
                            signal: stSignal,
                            cache: 'no-cache',
                        });
                        if (!resumed.ok || !resumed.body) throw new Error(`resume failed: ${resumed.status}`);
                        reader = resumed.body.getReader();
                        log('stream resumed', job.id, 'from byte', offset);
                    } catch (resumeError) {
                        if (stSignal?.aborted) {
                            controller.error(resumeError);
                            return;
                        }
                        log('resume attempt failed', job.id, resumeError?.message);
                    }
                }
            }
        },
        cancel(reason) {
            try { reader.cancel(reason).catch(() => { }); } catch { /* ignore */ }
        },
    });
}

// ---------------------------------------------------------------------------
// Local (browser-only) mode

function localRecord(job) {
    return {
        id: job.id,
        meta: job.meta,
        status: job.status,
        httpStatus: job.httpStatus,
        error: job.error,
        bytes: job.bytes,
        delivered: job.delivered,
        createdAt: job.createdAt,
        updatedAt: Date.now(),
        finishedAt: job.finishedAt,
        local: job.local,
        raw: job.raw,
        ownerTab: job.ownerTab,
    };
}

const persistTimers = new Map();
function persistLocalSoon(job) {
    if (persistTimers.has(job.id)) return;
    persistTimers.set(job.id, setTimeout(() => {
        persistTimers.delete(job.id);
        if (getJob(job.id)) storePut(localRecord(job));
    }, 1000));
}

function persistLocal(job) {
    clearTimeout(persistTimers.get(job.id));
    persistTimers.delete(job.id);
    return storePut(localRecord(job));
}

async function loadLocalJobs() {
    const records = await storeAll();
    const now = Date.now();
    for (const record of records) {
        if (getJob(record.id)) continue;
        if (record.status === 'running') {
            const mine = record.ownerTab === TAB_ID;
            const stale = now - (record.updatedAt || 0) > 20000;
            if (mine || stale) {
                record.status = 'interrupted';
                record.error = 'The page was reloaded or closed while the reply was being generated.';
                record.finishedAt = now;
                await storePut(record);
            }
        }
        const job = upsertFromInfo(record);
        if (job) {
            job.raw = record.raw || '';
            job.via = 'local';
        }
    }
}

function raceSignal(promise, signal, onAbort) {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
        let settled = false;
        const abort = () => {
            if (settled) return;
            settled = true;
            onAbort?.();
            reject(abortError());
        };
        if (signal.aborted) return abort();
        signal.addEventListener('abort', abort, { once: true });
        promise.then(
            (value) => { if (!settled) { settled = true; signal.removeEventListener('abort', abort); resolve(value); } },
            (error) => { if (!settled) { settled = true; signal.removeEventListener('abort', abort); reject(error); } },
        );
    });
}

async function localStart(job, url, init) {
    const ctrl = new AbortController();
    job.ctrl = ctrl;
    job.status = 'running';
    const stSignal = init.signal ?? null;
    persistLocal(job);

    const request = baseFetch(url, { ...init, signal: ctrl.signal });
    let response;
    try {
        response = await raceSignal(request, stSignal, () => {
            // ST stopped waiting before the API answered; keep the request alive on our own.
            request.then((r) => runDetached(job, r), (e) => failLocal(job, e));
        });
    } catch (error) {
        if (error?.name !== 'AbortError') failLocal(job, error);
        throw error;
    }

    job.httpStatus = response.status;
    if (!response.ok || !response.body) {
        job.status = 'error';
        job.handledByST = true;
        setTimeout(() => removeJob(job).catch(() => { }), 1500);
        return response;
    }

    const [forST, forUs] = response.body.tee();
    runLocal(job, forUs);
    return new Response(abortableBody(job, forST, stSignal), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    });
}

function abortableBody(job, stream, stSignal) {
    const reader = stream.getReader();
    let cancelled = false;
    return new ReadableStream({
        start(controller) {
            if (!stSignal) return;
            const onAbort = () => {
                cancelled = true;
                try { controller.error(abortError()); } catch { /* ignore */ }
                reader.cancel().catch(() => { });
            };
            if (stSignal.aborted) onAbort();
            else stSignal.addEventListener('abort', onAbort, { once: true });
        },
        async pull(controller) {
            try {
                const { done, value } = await reader.read();
                if (cancelled) return;
                if (done) {
                    job.stEof = true;
                    job.delivered = true;
                    controller.close();
                    return;
                }
                controller.enqueue(value);
            } catch (error) {
                if (!stSignal?.aborted) job.stFailed = true;
                try { controller.error(error); } catch { /* ignore */ }
            }
        },
        cancel() {
            reader.cancel().catch(() => { });
        },
    });
}

async function runDetached(job, response) {
    job.httpStatus = response.status;
    if (!response.ok || !response.body) {
        let text = '';
        try { text = await response.text(); } catch { /* ignore */ }
        job.status = 'error';
        job.error = text || `HTTP ${response.status}`;
        job.finishedAt = Date.now();
        await persistLocal(job);
        emitChange();
        hooks.onFinished(job);
        return;
    }
    runLocal(job, response.body);
}

async function runLocal(job, stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
        for (; ;) {
            const { done, value } = await reader.read();
            if (done) break;
            job.raw += decoder.decode(value, { stream: true });
            job.bytes += value.byteLength;
            persistLocalSoon(job);
            hooks.onProgress(job);
        }
        job.raw += decoder.decode();
        job.status = 'done';
    } catch (error) {
        job.status = job.ctrl?.signal?.aborted ? 'aborted' : 'error';
        if (job.status === 'error') job.error = error?.message || String(error);
    }
    job.finishedAt = Date.now();
    if (!getJob(job.id)) return; // removed meanwhile
    await persistLocal(job);
    emitChange();
    hooks.onFinished(job);
}

function failLocal(job, error) {
    if (isFinished(job)) return;
    job.status = job.ctrl?.signal?.aborted ? 'aborted' : 'error';
    job.error = error?.message || String(error);
    job.finishedAt = Date.now();
    persistLocal(job);
    emitChange();
    hooks.onFinished(job);
}

// ---------------------------------------------------------------------------
// Common operations

/** Pull job states from the plugin. Returns the list of known server ids, or null on failure. */
export async function refreshFromServer() {
    if (backend.mode !== 'plugin') return null;
    try {
        const response = await baseFetch(`${PLUGIN_BASE}/jobs`, { headers: getRequestHeaders(), cache: 'no-cache' });
        if (!response.ok) {
            if (response.status === 404) {
                backend.mode = 'local';
                backend.plugin = null;
                await loadLocalJobs();
                emitChange();
            }
            return null;
        }
        const data = await response.json();
        const ids = new Set();
        for (const info of data.jobs ?? []) {
            ids.add(info.id);
            const before = getJob(info.id);
            const wasFinished = before ? isFinished(before) : false;
            const job = upsertFromInfo(info);
            if (!job) continue;
            job.via ??= 'plugin';
            job.seenOnServer = true;
            if (!wasFinished && isFinished(job)) hooks.onFinished(job);
            else if (!isFinished(job)) hooks.onProgress(job);
        }
        // Jobs removed elsewhere (another tab or device already applied them)
        for (const job of allJobs()) {
            if (job.via === 'local') continue;
            if (!ids.has(job.id) && !job.attached && (job.seenOnServer || Date.now() - job.createdAt > 15000)) {
                forgetJob(job.id);
            }
        }
        return ids;
    } catch {
        return null;
    }
}

/** Reads the raw response text received so far (incrementally for plugin jobs). */
export async function readRaw(job) {
    if (job.via !== 'plugin') return job.raw || '';
    const response = await baseFetch(`${PLUGIN_BASE}/raw/${job.id}?from=${job.rawBytes}`, {
        headers: getRequestHeaders(),
        cache: 'no-cache',
    });
    if (!response.ok) throw new Error(`raw ${response.status}`);
    const buffer = await response.arrayBuffer();
    job.decoder ??= new TextDecoder();
    if (buffer.byteLength) {
        job.rawText += job.decoder.decode(buffer, { stream: true });
        job.rawBytes += buffer.byteLength;
    }
    const status = response.headers.get('x-bgr-status');
    if (status && ['done', 'error', 'aborted', 'interrupted'].includes(status) && Number(response.headers.get('x-bgr-bytes')) <= job.rawBytes) {
        job.rawText += job.decoder.decode();
        job.decoder = new TextDecoder();
    }
    return job.rawText;
}

export async function patchJob(job, local) {
    job.local = { ...job.local, ...local };
    if (job.via === 'plugin') {
        try {
            await baseFetch(`${PLUGIN_BASE}/patch/${job.id}`, {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ local }),
            });
        } catch { /* ignore */ }
    } else {
        await persistLocal(job);
    }
}

/** Make sure only one tab/device applies a finished job. */
export async function claimJob(job) {
    if (job.via !== 'plugin') return true;
    try {
        const response = await baseFetch(`${PLUGIN_BASE}/claim/${job.id}`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ owner: TAB_ID }),
        });
        return response.ok;
    } catch {
        return false;
    }
}

export async function abortJob(job) {
    if (job.via === 'plugin') {
        try {
            await baseFetch(`${PLUGIN_BASE}/abort/${job.id}`, { method: 'POST', headers: getRequestHeaders(), body: '{}' });
        } catch { /* ignore */ }
    } else {
        try { job.ctrl?.abort(); } catch { /* ignore */ }
    }
}

export async function removeJob(job) {
    forgetJob(job.id);
    if (job.via === 'plugin') {
        await serverRemove(job.id);
    } else {
        try { job.ctrl?.abort(); } catch { /* ignore */ }
        await storeDelete(job.id);
    }
}
