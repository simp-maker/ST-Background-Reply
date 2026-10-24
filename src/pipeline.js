// "/gen" (quiet generation) in the background.
//
// A /gen result is not a chat message: the slash command pipeline waits for it and the following
// commands (/sendas, QR post-processing, …) use it. So instead of putting the reply into the chat,
// we keep SillyTavern's own request waiting:
//  - the real request runs through the backend (plugin or tab); if streaming is on we ask the API to
//    stream so a live preview card can show the text as it arrives;
//  - SillyTavern gets the answer (as the normal non-streaming JSON it expects) only when the reply is
//    complete AND its chat is open again, so the rest of the pipeline runs in the right chat;
//  - SillyTavern is let go right away ("free input", default): its buttons are unlocked and the chat
//    input script that ran the /gen is released (scriptrun.js), so the user can send messages and run
//    other commands while the /gen is generating. With "free input" off (or "/gen lock=on") ST stays
//    blocked in this chat as before and is only let go when the user leaves the chat ("suspend").
//    Either way the rest of the script waits until the user is in the /gen's chat and ST is idle.

import {
    isGenerating,
    isStreamingEnabled,
    setSendButtonState,
    activateSendButtons,
    deactivateSendButtons,
    messageFormatting,
    getThumbnailUrl,
} from '../../../../../script.js';
import { startJob, readRaw, abortJob, removeJob, patchJob } from './backend.js';
import { emitChange, forgetJob, getJob, isFinished } from './jobs.js';
import { parseRaw } from './parse.js';
import { isChatOpen } from './apply.js';
import { flushEphemeralStoppingStrings } from '../../../../power-user.js';
import { releaseRun } from './scriptrun.js';
import { TAB_ID, abortError, escapeHtml, log, warn } from './utils.js';

/** job id -> { resolve, reject, busy } — SillyTavern's fetch() waiting for this job */
const waiters = new Map();
let attached = null;
let hooks = {
    onProgress: (_job) => { },
    onSettled: (_job) => { },
    freeInput: () => true,
};

export function initPipeline(next) {
    hooks = { ...hooks, ...next };
}

export function isPipeline(job) {
    return !!job?.meta?.pipeline;
}

export function hasWaiter(job) {
    return !!job && waiters.has(job.id);
}

export function hasAnyWaiter() {
    return waiters.size > 0;
}

/** The /gen job SillyTavern is blocked on right now (the user is still in its chat). */
export function getAttachedPipeline() {
    if (attached && !attached.suspended && waiters.has(attached.id)) return attached;
    return null;
}

/** The request is over (server/tab status; the end of our own read alone could be an abort). */
export function pipelineReady(job) {
    return isFinished(job);
}

function ownedHere(job) {
    return job.meta?.ownerTab === TAB_ID || job.ownerTab === TAB_ID;
}

// ---------------------------------------------------------------------------

function canForceStream(meta, body) {
    if (!isStreamingEnabled()) return false;
    if (body.json_schema || body.response_format?.type === 'json_schema' || body.grammar_string || body.json_schema_object) return false;
    if (meta.api === 'openai' && ['o1', 'o1-2024-12-17'].includes(String(body.model))) return false;
    return true;
}

/**
 * Called by the fetch wrapper for a tagged /gen request.
 * @returns {Promise<Response>} resolves when the result may be handed to SillyTavern
 */
export async function startPipeline(job, path, init, gen = {}) {
    const stSignal = init.signal ?? null;
    let body = init.body;
    let parsedBody = null;
    try { parsedBody = JSON.parse(body); } catch { /* keep as is */ }
    if (parsedBody && !parsedBody.stream && canForceStream(job.meta, parsedBody)) {
        parsedBody.stream = true;
        body = JSON.stringify(parsedBody);
        job.meta.stream = true;
        job.meta.streamForced = true;
    } else {
        job.meta.stream = !!parsedBody?.stream;
    }

    job.scriptCtrl = gen.ctrl ?? null;
    let free = false;
    try { free = !gen.lock && hooks.freeInput() !== false; } catch { /* keep blocking */ }
    attached = free ? null : job;
    return new Promise((resolve, reject) => {
        // Registered right away, so the user can leave even before the API answers.
        waiters.set(job.id, { resolve, reject, busy: false });
        if (free) freeNow(job, { unlock: !gen.busyBefore });
        if (stSignal) {
            const onAbort = () => {
                // Stop pressed while SillyTavern was waiting in this chat. After a suspend, ST's
                // stop button belongs to other generations, so it must not cancel this one.
                if (job.suspended || !waiters.has(job.id)) return;
                waiters.delete(job.id);
                if (attached === job) attached = null;
                removeCard(job);
                job.local.stoppedByUser = true;
                reject(abortError());
                removeJob(job).catch(() => { });
            };
            if (stSignal.aborted) onAbort();
            else stSignal.addEventListener('abort', onAbort, { once: true });
        }
        queueMicrotask(() => hooks.onProgress(job)); // show the card right away

        const stillWaitingHere = () => waiters.has(job.id) && !job.suspended;
        const failLater = (message, status = null) => {
            job.status = 'error';
            job.error = message;
            if (status) job.httpStatus = status;
            job.finishedAt = Date.now();
            emitChange();
            hooks.onSettled(job);
        };

        (async () => {
            let response;
            try {
                response = await startJob(job, path, { ...init, body, signal: undefined });
            } catch (error) {
                if (stillWaitingHere()) {
                    waiters.delete(job.id);
                    if (attached === job) attached = null;
                    removeCard(job);
                    forgetJob(job.id);
                    reject(error);
                } else {
                    failLater(error?.message || String(error));
                }
                return;
            }
            if (!response.ok || !response.body) {
                if (stillWaitingHere()) {
                    // The API refused right away and ST still waits here: let it show the error itself.
                    waiters.delete(job.id);
                    if (attached === job) attached = null;
                    removeCard(job);
                    job.handledByST = true;
                    resolve(response);
                    setTimeout(() => removeJob(job).catch(() => { }), 1500);
                } else {
                    let text = '';
                    try { text = await response.text(); } catch { /* ignore */ }
                    job.raw = text;
                    failLater(text || `HTTP ${response.status}`, response.status);
                }
                return;
            }
            if (job.suspended) patchJob(job, { detached: true }).catch(() => { });
            readBody(job, response.body);
        })();
    });
}

async function readBody(job, stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    job.pipeRaw = '';
    try {
        for (; ;) {
            const { done, value } = await reader.read();
            if (done) break;
            job.pipeRaw += decoder.decode(value, { stream: true });
            hooks.onProgress(job);
        }
        job.pipeRaw += decoder.decode();
        job.pipeDone = true;
    } catch (error) {
        job.pipeReadError = error?.message || String(error);
        warn('/gen stream read failed, will use the stored copy', job.id, job.pipeReadError);
    }
    emitChange();
    hooks.onSettled(job);
}

/**
 * "Free input": SillyTavern stops waiting for this /gen right after the request went out.
 * @param {boolean} unlock unlock ST's buttons (not when another generation was already running
 *   before this /gen started: that one still owns them)
 */
function freeNow(job, { unlock }) {
    job.suspended = true;
    job.local.detached = true;
    job.freeInput = true;
    if (unlock) {
        // The request body is built already: /gen's "stop=" strings must not leak into what the user
        // generates next. (TempResponseLength for "length=" restores itself before sending.)
        try { flushEphemeralStoppingStrings(); } catch { /* ignore */ }
        setSendButtonState(false);
        activateSendButtons();
    }
    releaseRun(job.scriptCtrl);
    log('/gen runs in the background, input is free', job.id);
    emitChange();
}

/** Lets SillyTavern go (buttons, chat switching) while this /gen keeps running. */
export function suspendAttached() {
    const job = getAttachedPipeline();
    if (!job) return false;
    job.suspended = true;
    job.local.detached = true;
    patchJob(job, { detached: true }).catch(() => { });
    removeCard(job);
    try { flushEphemeralStoppingStrings(); } catch { /* ignore */ }
    setSendButtonState(false);
    activateSendButtons();
    // the chat input script that ran this /gen must not keep the input locked in other chats
    releaseRun(job.scriptCtrl);
    log('/gen continues in the background', job.id);
    emitChange();
    return true;
}

function jsonResponse(object, status = 200) {
    return new Response(JSON.stringify(object), { status, headers: { 'content-type': 'application/json' } });
}

function buildResponse(job, raw) {
    const complete = job.status === 'done';
    if (!job.meta.streamForced && complete && !job.pipeReadError) {
        return new Response(raw, { status: job.httpStatus || 200, headers: { 'content-type': 'application/json' } });
    }
    const parsed = parseRaw(job.meta, raw, { partial: false });
    const text = parsed.text || '';
    if (!text.trim()) {
        const message = parsed.error || job.error || (job.status === 'interrupted' ? '생성이 중단됐어요.' : '빈 응답');
        return jsonResponse({ error: { message } }, 500);
    }
    if (!complete || parsed.error) {
        toastr.warning('/gen 결과를 일부만 받았어요. 받은 부분으로 이어서 진행해요.', '백그라운드 답장');
    }
    return job.meta.api === 'openai'
        ? jsonResponse({ choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] })
        : jsonResponse({ choices: [{ index: 0, text }] });
}

/**
 * Hands the result to SillyTavern if the reply is complete, its chat is open and ST is free.
 * @returns {Promise<boolean>} delivered
 */
export async function tryDeliver(job, { applyBusy = () => false } = {}) {
    const waiter = waiters.get(job.id);
    if (!waiter || waiter.busy) return false;
    if (!pipelineReady(job)) return false;
    if (!isChatOpen(job.meta.chat)) return false;
    if (job.suspended && (isGenerating() || applyBusy())) return false;

    waiter.busy = true;
    let raw = job.pipeDone && !job.pipeReadError ? job.pipeRaw : null;
    if (raw === null) {
        try {
            raw = await readRaw(job);
        } catch (error) {
            waiter.busy = false;
            warn('could not read /gen result', job.id, error);
            return false;
        }
    }
    if (!isChatOpen(job.meta.chat) || (job.suspended && isGenerating())) {
        waiter.busy = false;
        return false;
    }

    waiters.delete(job.id);
    if (attached === job) attached = null;
    removeCard(job);
    if (job.suspended) {
        // ST will finish the /gen and unlock itself, like it normally does.
        setSendButtonState(true);
        deactivateSendButtons();
    }
    job.suspended = false;

    if (job.discardResult || (job.stopRequested && !(raw && parseRaw(job.meta, raw, { partial: false }).text.trim()))) {
        waiter.reject(abortError());
    } else {
        waiter.resolve(buildResponse(job, raw ?? ''));
    }
    log('/gen result handed back', job.id);
    await removeJob(job);
    return true;
}

/** Stop button on the card / in the panel. */
export async function stopPipeline(job) {
    job.stopRequested = true;
    job.local.stoppedByUser = true;
    patchJob(job, { stoppedByUser: true }).catch(() => { });
    await abortJob(job);
}

/** A /gen whose page was reloaded: nobody waits for it any more. */
export function isOrphan(job) {
    return isPipeline(job) && !waiters.has(job.id);
}

export function orphanTextOf(job, raw) {
    return parseRaw(job.meta, raw, { partial: false }).text || '';
}

export function shouldAdoptOrphan(job) {
    if (!isFinished(job)) return false;
    return ownedHere(job) || Date.now() - (job.finishedAt || 0) > 60000;
}

// ---------------------------------------------------------------------------
// Live preview card at the bottom of the open chat

function speaker(job) {
    const name = job.meta.speaker?.name || job.meta.chatName || '';
    const avatar = job.meta.speaker?.avatar;
    let url = 'img/ai4.png';
    if (avatar && avatar !== 'none') {
        try { url = getThumbnailUrl('avatar', avatar); } catch { /* ignore */ }
    }
    return { name, url };
}

export function removeCard(job) {
    document.querySelectorAll(`#chat .bgr-gen-card[data-job="${CSS.escape(job.id)}"]`).forEach(el => el.remove());
}

export function renderCard(job, text, onStop) {
    const chatElement = document.getElementById('chat');
    if (!chatElement) return;
    const nearBottom = chatElement.scrollHeight - chatElement.scrollTop - chatElement.clientHeight < 120;
    let card = chatElement.querySelector(`.bgr-gen-card[data-job="${CSS.escape(job.id)}"]`);
    if (!card) {
        const { name, url } = speaker(job);
        card = document.createElement('div');
        card.className = 'bgr-gen-card';
        card.dataset.job = job.id;
        card.innerHTML = `
            <div class="bgr-gen-avatar"><img alt="" src="${escapeHtml(url)}"></div>
            <div class="bgr-gen-body">
              <div class="bgr-gen-head">
                <b class="bgr-gen-name">${escapeHtml(name)}</b>
                <span class="bgr-gen-tag">/gen</span>
                <span class="bgr-live-dot"></span>
                <span class="bgr-gen-state">생성 중</span>
                <button type="button" class="menu_button bgr-live-stop" title="이 /gen을 멈춥니다">중지</button>
              </div>
              <div class="bgr-gen-text"></div>
            </div>`;
        card.querySelector('.bgr-live-stop').addEventListener('click', (event) => {
            event.stopPropagation();
            card.querySelector('.bgr-gen-state').textContent = '멈추는 중…';
            onStop(job);
        });
    }
    if (card.parentElement !== chatElement || card !== chatElement.lastElementChild) {
        chatElement.append(card);
    }
    const textElement = card.querySelector('.bgr-gen-text');
    if (text) {
        textElement.innerHTML = messageFormatting(text, job.meta.speaker?.name ?? '', false, false, -1, {}, false);
        textElement.classList.remove('bgr-gen-empty');
    } else {
        textElement.textContent = job.meta.stream ? '…' : '스트리밍이 꺼져 있어 완성되면 이어서 진행해요.';
        textElement.classList.add('bgr-gen-empty');
    }
    card.querySelector('.bgr-gen-state').textContent = job.stopRequested ? '멈추는 중…' : (job.suspended ? '백그라운드에서 생성 중' : '생성 중');
    card.classList.toggle('bgr-gen-free', !!job.freeInput);
    card.title = job.freeInput ? '생성되는 동안에도 메시지를 보내거나 다른 명령을 실행할 수 있어요. 결과는 다른 생성이 끝난 뒤에 이어서 처리돼요.' : '';
    if (nearBottom) chatElement.scrollTop = chatElement.scrollHeight;
}

/** Text received so far, for the card. */
export async function liveText(job) {
    let raw = job.pipeRaw;
    if (raw === undefined) {
        try { raw = await readRaw(job); } catch { raw = ''; }
    }
    return job.meta.stream ? parseRaw(job.meta, raw, { partial: true }).text : '';
}

export function forgetWaiterIfGone(job) {
    if (!getJob(job.id)) waiters.delete(job.id);
}
