// In-memory registry of background jobs (one job = one generation request).

import { FINISHED, TAB_ID } from './utils.js';

/** @type {Map<string, any>} */
const jobs = new Map();
const listeners = new Set();
let changeQueued = false;

export function onJobsChanged(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export function emitChange() {
    if (changeQueued) return;
    changeQueued = true;
    queueMicrotask(() => {
        changeQueued = false;
        for (const fn of listeners) {
            try { fn(); } catch (error) { console.error('[BgReply] listener failed', error); }
        }
    });
}

export function allJobs() {
    return [...jobs.values()];
}

export function getJob(id) {
    return jobs.get(id) ?? null;
}

export function hasJob(id) {
    return jobs.has(id);
}

export function isFinished(job) {
    return FINISHED.has(job?.status);
}

/** Finished (kept as a separate name for the dock). */
export function isReceived(job) {
    return isFinished(job);
}

/** Runtime-only fields that never leave this tab. */
function runtime() {
    return {
        attached: false,        // SillyTavern itself is currently reading this response
        detachRequested: false, // we stopped ST on purpose (chat switch); the request keeps running
        stEof: false,           // ST received the whole response
        rawText: '',
        rawBytes: 0,
        decoder: null,
        raw: '',
        ctrl: null,
        handling: null,
        notified: false,
        preview: '',
        seenAt: 0,
    };
}

export function createJob(meta) {
    const now = Date.now();
    const job = {
        id: meta.id,
        meta,
        status: 'running',
        httpStatus: null,
        error: null,
        bytes: 0,
        delivered: false,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
        local: {},
        ownerTab: TAB_ID,
        ...runtime(),
    };
    jobs.set(job.id, job);
    emitChange();
    return job;
}

/** Adds or updates a job from a plugin / storage record. Returns the job. */
export function upsertFromInfo(info) {
    let job = jobs.get(info.id);
    if (!job) {
        if (!info.meta) return null;
        job = { ...info, ownerTab: info.meta?.ownerTab ?? null, ...runtime() };
        jobs.set(job.id, job);
        emitChange();
        return job;
    }
    let changed = false;
    for (const key of ['status', 'httpStatus', 'error', 'bytes', 'delivered', 'finishedAt', 'updatedAt']) {
        if (info[key] !== undefined && job[key] !== info[key]) {
            // never move a job back from finished to running
            if (key === 'status' && isFinished(job) && !FINISHED.has(info.status)) continue;
            job[key] = info[key];
            changed = true;
        }
    }
    if (info.local && JSON.stringify(info.local) !== JSON.stringify(job.local)) {
        job.local = { ...job.local, ...info.local };
        changed = true;
    }
    if (changed) emitChange();
    return job;
}

export function forgetJob(id) {
    if (jobs.delete(id)) emitChange();
}
