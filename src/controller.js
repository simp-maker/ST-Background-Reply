// Decides what happens with each background job: live preview, applying to the open chat,
// or a corner notification for chats that are not open.

import { isGenerating, saveChatConditional } from '../../../../../script.js';
import { eventSource, event_types } from '../../../../events.js';
import {
    backend, setBackendHooks, refreshFromServer, readRaw, patchJob, claimJob, abortJob, removeJob,
} from './backend.js';
import { allJobs, emitChange, getJob, isFinished, onJobsChanged } from './jobs.js';
import { parseRaw } from './parse.js';
import {
    alreadyInChat, chatKeyString, discardPlaceholder, fillJob, findMarker, isChatOpen,
    markerIdsInChat, placeJob, processResult, scrollToMessage, showLive,
} from './apply.js';
import { getActiveJob, settleActive } from './capture.js';
import { browserNotify, playDing, render as renderDock } from './notify.js';
import {
    hasAnyWaiter, hasWaiter, initPipeline, isPipeline, liveText, orphanTextOf, pipelineReady,
    removeCard, renderCard, shouldAdoptOrphan, stopPipeline, tryDeliver,
} from './pipeline.js';
import { openChat } from './nav.js';
import { TAB_ID, delay, log, plainPreview, warn } from './utils.js';

const loadedAt = Date.now();
let getSettings = () => ({});
let applyChain = Promise.resolve();
let applyDepth = 0;
let presentMarkers = new Set();
let pendingScroll = null; // { key, until }
let idleTicks = 0;
const lastLive = new Map();
const liveTimers = new Map();

export function applyBusy() {
    return applyDepth > 0;
}

export async function applyIdle() {
    for (let i = 0; i < 20 && applyDepth > 0; i++) {
        await applyChain;
        await delay(0);
    }
}

function exclusive(fn) {
    applyDepth++;
    const run = applyChain.then(fn).catch(error => warn('task failed', error)).finally(() => { applyDepth--; });
    applyChain = run;
    return run;
}

function ownedHere(job) {
    return job.meta?.ownerTab === TAB_ID || job.ownerTab === TAB_ID;
}

/** Running jobs are only ours to show once ST no longer streams them somewhere else. */
function isDetachedForUs(job) {
    return !!job.local?.detached || ownedHere(job);
}

export function isNotifiable(job) {
    if (!job?.meta?.chat) return false;
    if (isPipeline(job)) {
        if (isChatOpen(job.meta.chat) || job.handledByST) return false;
        if (job.local?.unplaced || job.local?.dismissed || job.local?.dropped) return false;
        if (hasWaiter(job)) {
            if (!job.suspended) return false;
            if (pipelineReady(job)) return true;
            return getSettings().showRunning !== false;
        }
        // nobody waits for it any more (page reloaded): show this tab's running ones
        return !isFinished(job) && ownedHere(job) && getSettings().showRunning !== false;
    }
    if (job.attached || job.handledByST) return false;
    if (job.local?.dropped || job.local?.dismissed || job.local?.unplaced) return false;
    if (isChatOpen(job.meta.chat)) return false;
    if (isFinished(job)) {
        if (job.delivered && !job.local?.detached) return false;
        if (job.status === 'aborted' && job.local?.stoppedByUser && !job.preview) return false;
        return true;
    }
    if (getSettings().showRunning === false) return false;
    return isDetachedForUs(job);
}

export function initController({ settings }) {
    getSettings = settings;

    setBackendHooks({
        onProgress: (job) => scheduleLive(job),
        onFinished: (job) => route(job),
    });
    initPipeline({
        onProgress: (job) => scheduleLive(job),
        onSettled: () => poll(), // fetch the final status right away
    });

    onJobsChanged(() => renderDock());

    eventSource.on(event_types.CHAT_CHANGED, () => {
        lastLive.clear();
        renderDock();
        setTimeout(() => {
            presentMarkers = markerIdsInChat();
            for (const job of allJobs()) route(job);
            renderDock();
        }, 60);
    });

    // a /gen waiting for SillyTavern to be idle again can go on right away
    const onGenerationOver = () => { if (hasAnyWaiter()) setTimeout(poll, 400); };
    eventSource.on(event_types.GENERATION_ENDED, onGenerationOver);
    eventSource.on(event_types.GENERATION_STOPPED, onGenerationOver);

    const onDeleted = () => setTimeout(checkDeletedMarkers, 0);
    eventSource.on(event_types.MESSAGE_DELETED, onDeleted);
    eventSource.on(event_types.MESSAGE_SWIPE_DELETED, onDeleted);

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) poll();
    });

    pollLoop();
}

/** Called by capture when ST stopped reading a reply that keeps going. */
export function onReleased(job) {
    const loc = findMarker(job.id);
    if (loc && isChatOpen(job.meta.chat)) presentMarkers.add(job.id);
    emitChange();
    setTimeout(() => route(job), 0);
}

function checkDeletedMarkers() {
    const now = markerIdsInChat();
    for (const id of presentMarkers) {
        if (now.has(id)) continue;
        const job = getJob(id);
        if (!job || !isChatOpen(job.meta.chat) || job.handling) continue;
        // The user deleted the message/swipe this reply was going into: drop the reply.
        log('placeholder deleted by user, dropping', id);
        job.local.dropped = true;
        if (!isFinished(job)) abortJob(job);
        removeJob(job);
    }
    presentMarkers = new Set([...now].filter(id => getJob(id)));
}

// ---------------------------------------------------------------------------

export function route(job) {
    if (job && isPipeline(job)) {
        routePipeline(job);
        return;
    }
    if (!job || !getJob(job.id) || job.attached || job.handledByST || job.handling) return;

    if (isFinished(job)) {
        if (job.delivered && !job.local?.detached) {
            removeJob(job);
            return;
        }
        if (job.local?.dropped) {
            removeJob(job);
            return;
        }
        if (job.local?.unplaced) return;
        // Another tab streamed this one itself; give it a moment to confirm delivery.
        if (!job.local?.detached && !ownedHere(job) && Date.now() - (job.finishedAt || 0) < 8000) return;

        if (isChatOpen(job.meta.chat)) {
            job.handling = exclusive(() => applyFinished(job)).finally(() => { job.handling = null; });
        } else {
            notifyFinished(job);
        }
        return;
    }

    if (isDetachedForUs(job) && isChatOpen(job.meta.chat)) scheduleLive(job);
}

function routePipeline(job) {
    if (!getJob(job.id) || job.handledByST || job.handling) return;
    const open = isChatOpen(job.meta.chat);
    if (hasWaiter(job)) {
        if (pipelineReady(job)) {
            if (open) {
                // (already inside the exclusive chain, so "busy" must not block it)
                job.handling = exclusive(() => tryDeliver(job, { applyBusy: () => false }))
                    .finally(() => { job.handling = null; });
            } else {
                notifyFinished(job);
            }
        } else if (open) {
            scheduleLive(job);
        }
        return;
    }
    // Nobody waits for this /gen any more (the page was reloaded).
    if (isFinished(job)) {
        if (job.local?.unplaced) return;
        if (job.local?.dropped || job.local?.stoppedByUser) {
            removeJob(job);
            return;
        }
        if (shouldAdoptOrphan(job)) {
            job.handling = exclusive(() => adoptOrphan(job)).finally(() => { job.handling = null; });
        }
        return;
    }
    if (ownedHere(job) && open) scheduleLive(job);
}

async function adoptOrphan(job) {
    let raw = '';
    try {
        raw = await readRaw(job);
    } catch {
        return;
    }
    removeCard(job);
    const text = orphanTextOf(job, raw);
    if (!text.trim()) {
        await removeJob(job);
        return;
    }
    job.local.unplaced = true;
    job.local.text = text;
    job.local.pipelineOrphan = true;
    await patchJob(job, { unplaced: true, text, pipelineOrphan: true });
    emitChange();
    if (ownedHere(job)) {
        toastr.info('페이지가 새로고침돼서 /gen 다음 단계(QR 후처리 등)는 이어서 실행하지 못했어요. 결과 텍스트는 확장 설정 → 백그라운드 답장 → 보관함에 있어요.', '/gen 결과 보관', { timeOut: 12000 });
    }
}

async function notifyFinished(job) {
    if (job.notified) return;
    job.notified = true;
    try {
        const raw = isPipeline(job) && job.pipeDone ? job.pipeRaw : await readRaw(job);
        const parsed = parseRaw(job.meta, raw, { partial: false });
        job.preview = plainPreview(parsed.text);
    } catch { /* ignore */ }
    emitChange();
    if (!isNotifiable(job)) return;
    const fresh = (job.finishedAt || Date.now()) > loadedAt - 3000;
    if (fresh && (job.preview || job.status === 'done')) {
        const settings = getSettings();
        if (settings.sound) playDing();
        if (settings.browserNotify) browserNotify(job, job.preview);
    }
}

function errorMessage(job, parsed) {
    if (parsed?.tools) return '도구 호출(function calling) 응답은 백그라운드에서 처리할 수 없어요.';
    if (job.status === 'interrupted') {
        return job.via === 'local'
            ? '생성 도중 페이지가 새로고침되었거나 닫혀서 멈췄어요.'
            : '생성 도중 SillyTavern 서버가 꺼지거나 재시작돼서 멈췄어요.';
    }
    let text = parsed?.error || job.error || '';
    if (/^upstream aborted$|^stream error$|ECONNRESET|socket hang up/i.test(text)) text = '서버와 AI API 사이의 연결이 끊겼어요.';
    try {
        const data = JSON.parse(text);
        text = data?.error?.message || data?.message || text;
    } catch { /* not JSON */ }
    text = String(text || '').trim();
    if (!text) {
        if (job.status === 'interrupted') text = '생성 도중 연결이 끊겼어요.';
        else if (job.status === 'aborted') text = '중지됨';
        else text = '빈 응답';
    }
    return text.length > 300 ? text.slice(0, 300) + '…' : text;
}

function speakerName(job) {
    return job.meta.speaker?.name || job.meta.chatName || '캐릭터';
}

async function applyFinished(job) {
    if (!getJob(job.id)) return;
    const key = job.meta.chat;
    if (!isChatOpen(key)) return;
    if (!(await claimJob(job))) return;

    let raw;
    try {
        raw = await readRaw(job);
    } catch (error) {
        warn('could not read reply', job.id, error);
        return; // try again on the next poll
    }
    if (!isChatOpen(key) || !getJob(job.id)) return;

    const parsed = parseRaw(job.meta, raw, { partial: false });
    const result = processResult(job, parsed);
    const hasText = job.meta.type === 'continue' ? !!result.text : !!result.text.trim();
    let loc = findMarker(job.id);

    if (!hasText) {
        if (loc) await discardPlaceholder(job, loc);
        if (!(job.status === 'aborted' && job.local?.stoppedByUser)) {
            toastr.error(errorMessage(job, parsed), `${speakerName(job)} 답장 생성 실패`, { timeOut: 10000 });
        }
        presentMarkers.delete(job.id);
        await removeJob(job);
        return;
    }

    if (!loc) {
        if (alreadyInChat(job, result.text)) {
            log('reply already in chat, skipping', job.id);
            await removeJob(job);
            return;
        }
        loc = placeJob(job, result.text);
        if (!loc) {
            job.local.unplaced = true;
            job.local.text = result.text;
            await patchJob(job, { unplaced: true, text: result.text });
            emitChange();
            toastr.warning('답장이 들어갈 자리를 찾지 못했어요 (메시지가 수정/삭제된 것 같아요). 확장 설정의 "백그라운드 답장 → 보관함"에서 확인할 수 있어요.', `${speakerName(job)}의 답장`, { timeOut: 10000 });
            return;
        }
    }

    const placed = await fillJob(job, loc, result);
    presentMarkers.delete(job.id);
    log('applied', job.id, placed);

    if (job.status === 'aborted' && job.local?.stoppedByUser) {
        // stopped on purpose: keep what was written, no warning
    } else if (job.status !== 'done') {
        toastr.warning(`답장 일부만 받았어요. (${errorMessage(job, parsed)})`, `${speakerName(job)}의 답장`, { timeOut: 8000 });
    }

    if (placed && pendingScroll && pendingScroll.key === chatKeyString(key) && Date.now() < pendingScroll.until) {
        scrollToMessage(placed.index);
    }
    await removeJob(job);
}

// ---------------------------------------------------------------------------
// Live preview

function scheduleLive(job) {
    if (!job) return;
    if (isPipeline(job)) {
        if (!isChatOpen(job.meta.chat) || (!hasWaiter(job) && (!ownedHere(job) || isFinished(job)))) return;
    } else if (job.attached || isFinished(job) || !isDetachedForUs(job) || !isChatOpen(job.meta.chat)) {
        return;
    }
    if (liveTimers.has(job.id)) return;
    const wait = Math.max(0, 900 - (Date.now() - (lastLive.get(job.id) || 0)));
    liveTimers.set(job.id, setTimeout(() => {
        liveTimers.delete(job.id);
        if (job.handling || !getJob(job.id)) return;
        job.handling = exclusive(() => liveTick(job)).finally(() => {
            job.handling = null;
            if (isFinished(job)) route(job);
        });
    }, wait));
}

async function liveTick(job) {
    lastLive.set(job.id, Date.now());
    if (isPipeline(job)) {
        if (!isChatOpen(job.meta.chat) || !getJob(job.id)) return;
        if (hasWaiter(job) && pipelineReady(job)) return; // being handed back
        const text = getSettings().livePreview === false ? '' : await liveText(job);
        if (!isChatOpen(job.meta.chat) || !getJob(job.id)) return;
        renderCard(job, text, stopJob);
        return;
    }
    if (!isChatOpen(job.meta.chat) || isFinished(job) || job.local?.dropped) return;
    let text = '';
    try {
        const raw = await readRaw(job);
        text = parseRaw(job.meta, raw, { partial: true }).text;
    } catch { /* ignore */ }
    if (!isChatOpen(job.meta.chat) || isFinished(job) || !getJob(job.id)) return;
    let loc = findMarker(job.id);
    if (!loc) {
        loc = placeJob(job, text);
        if (!loc) return;
        presentMarkers.add(job.id);
        await saveChatConditional();
        patchJob(job, { placed: true });
    }
    presentMarkers.add(job.id);
    if (getSettings().livePreview === false) text = '';
    const current = findMarker(job.id);
    if (current) showLive(job, current, text, stopJob);
}

export async function stopJob(job) {
    if (isPipeline(job)) {
        await stopPipeline(job);
        poll();
        return;
    }
    job.local.stoppedByUser = true;
    await patchJob(job, { stoppedByUser: true });
    await abortJob(job);
    poll();
}

// ---------------------------------------------------------------------------
// Opening chats from the dock

export async function openFromDock(key) {
    pendingScroll = { key: chatKeyString(key), until: Date.now() + 8000 };
    const ok = await openChat(key);
    if (!ok) return;
    await delay(120);
    for (const job of allJobs()) route(job);
    // running or already applied: scroll to where it is
    for (const job of allJobs()) {
        if (chatKeyString(job.meta.chat) !== pendingScroll.key) continue;
        const loc = findMarker(job.id);
        if (loc) {
            scrollToMessage(loc.index);
            break;
        }
    }
}

export async function dismiss(jobs) {
    for (const job of jobs) {
        job.local.dismissed = true;
        patchJob(job, { dismissed: true });
    }
    emitChange();
}

// ---------------------------------------------------------------------------
// Polling

let pollTimer = null;
let polling = false;

export function poll() {
    clearTimeout(pollTimer);
    pollLoop();
}

async function pollLoop() {
    if (polling) return;
    polling = true;
    try {
        if (backend.mode === 'plugin') await refreshFromServer();

        if (getActiveJob()) {
            if (!isGenerating()) idleTicks++;
            else idleTicks = 0;
            if (idleTicks >= 3) {
                idleTicks = 0;
                settleActive(false);
            }
        }

        for (const job of allJobs()) route(job);
    } catch (error) {
        warn('poll failed', error);
    } finally {
        polling = false;
    }
    const jobs = allJobs();
    const busy = jobs.some(job => !isFinished(job)) || !!getActiveJob() || hasAnyWaiter();
    const waiting = jobs.some(job => isNotifiable(job));
    const wait = busy ? 1500 : waiting ? 3000 : (document.hidden ? 20000 : 7000);
    clearTimeout(pollTimer);
    pollTimer = setTimeout(pollLoop, wait);
}
