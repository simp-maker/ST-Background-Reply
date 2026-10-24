// Hooks into SillyTavern's generation flow.
//  1. GENERATE_AFTER_DATA / CHAT_COMPLETION_SETTINGS_READY tag the outgoing request body with a job id.
//  2. The fetch wrapper recognises the tagged request, strips the tag and runs it through the backend
//     (plugin or tab), giving SillyTavern a normal-looking Response so streaming works as usual.
//  3. Afterwards we decide what happened:
//     - ST read the whole response            -> nothing to do, the job is removed
//     - the user pressed Stop                  -> the request is cancelled for real
//     - ST stopped reading early (we detached
//       for a chat switch, page reload, network
//       drop)                                  -> the job keeps running and is applied later

import {
    main_api,
    characters,
    this_chid,
    isStreamingEnabled,
    isGenerating,
    getGeneratingModel,
    getGeneratingApi,
} from '../../../../../script.js';
import { eventSource, event_types } from '../../../../events.js';
import { selected_group, groups } from '../../../../group-chats.js';
import { oai_settings } from '../../../../openai.js';
import { textgenerationwebui_settings } from '../../../../textgen-settings.js';
import { GEN_URLS, SUPPORTED_TYPES, TAB_ID, uid, log, warn } from './utils.js';
import { createJob, forgetJob } from './jobs.js';
import { startJob, removeJob, patchJob } from './backend.js';
import { currentChatKey, describeTarget, markExistingMessage } from './apply.js';
import { startPipeline } from './pipeline.js';
import { isReleasedRun } from './scriptrun.js';

let getSettings = () => ({ enabled: true });
let backendReady = Promise.resolve();
let onReleased = (_job) => { };

let genType = null;
let genHasQuietPrompt = false;
let genForceChid = null;
let genFromCommand = false;
let genTicket = 0; // time the /gen command started (its Generate('quiet') follows right after)
let genTicketInfo = null; // { ctrl, lock } of that /gen command call
let genInfo = null; // the same, for the generation that is running now
let overrideWarned = false;
let armed = null;
let active = null;

/** Chat saves seen through fetch (used to wait for ST's own save before switching chats). */
export const saveState = { seq: 0, pending: 0 };
const SAVE_URLS = new Set(['/api/chats/save', '/api/chats/group/save']);

export function getActiveJob() {
    return active;
}

// After a reply is received ST saves the chat a moment later. Switching chats in between makes
// ST save into the wrong chat (or lose the reply), so chat switches wait for that save.
let expectSaveAfter = -1;
let expectSaveUntil = 0;
export function isSaveExpected() {
    if (saveState.pending > 0) return true;
    if (expectSaveAfter < 0) return false;
    if (saveState.seq > expectSaveAfter || Date.now() > expectSaveUntil) {
        expectSaveAfter = -1;
        return false;
    }
    return true;
}

export function initCapture({ settings, ready, released }) {
    getSettings = settings;
    backendReady = ready;
    onReleased = released;
    installFetchWrapper();
    let tries = 0;
    const timer = setInterval(() => {
        if (wrapGenCommand() || ++tries > 60) clearInterval(timer);
    }, 500);
    eventSource.on(event_types.APP_READY, () => wrapGenCommand());

    eventSource.on(event_types.GENERATION_STARTED, (type, options, dryRun) => {
        if (dryRun) return;
        genType = type || 'normal';
        genHasQuietPrompt = !!options?.quiet_prompt;
        genForceChid = options?.force_chid ?? null;
        genFromCommand = genType === 'quiet' && genTicket > 0 && Date.now() - genTicket < 5000;
        genInfo = genFromCommand ? { ...genTicketInfo, busyBefore: isGenerating() } : null;
        genTicket = 0;
        genTicketInfo = null;
        armed = null;
    });

    eventSource.on(event_types.GENERATE_AFTER_DATA, (data, dryRun) => {
        if (dryRun) return;
        armed = null;
        const settings = getSettings();
        if (!settings.enabled) return;
        const type = genType || 'normal';
        let pipeline = false;
        if (type === 'quiet') {
            // Only /gen: other quiet generations (summaries, extensions) keep ST's normal behaviour.
            if (!genFromCommand || settings.genBackground === false) return;
            pipeline = true;
        } else {
            if (!SUPPORTED_TYPES.has(type)) return;
            // A script calling Generate('normal', { quiet_prompt }) and reading the result itself:
            // its pipeline would continue with half a reply, so leave it to ST.
            if (genHasQuietPrompt) {
                if (isGenOverrideInstalled() && !overrideWarned && settings.genBackground !== false) {
                    overrideWarned = true;
                    toastr.info('\'/gen 스트리밍\' 스크립트가 켜져 있어서 이 /gen은 생성 중에 이동할 수 없어요. 백그라운드 답장 확장이 /gen 실시간 미리보기를 대신하니, JS-Slash-Runner에서 그 스크립트를 꺼 주세요.', '백그라운드 답장', { timeOut: 12000 });
                }
                return;
            }
        }
        if (main_api !== 'openai' && main_api !== 'textgenerationwebui') return;
        const meta = buildMeta(type, pipeline);
        if (!meta) return;
        armed = { meta, at: Date.now(), promptRef: data?.prompt, tagged: false, gen: pipeline ? genInfo : null };
        if (main_api === 'textgenerationwebui' && data && typeof data === 'object') {
            data.__bgr = meta.id;
            armed.tagged = true;
        }
    });

    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, (data) => {
        if (!armed || armed.tagged || armed.meta.api !== 'openai' || !data || typeof data !== 'object') return;
        if (Date.now() - armed.at > 15000) {
            armed = null;
            return;
        }
        if (!samePrompt(armed.promptRef, data.messages)) return;
        data.__bgr = armed.meta.id;
        armed.tagged = true;
    });

    eventSource.on(event_types.GENERATION_STOPPED, () => {
        const job = active;
        if (!job || job.detachRequested) return;
        // The user pressed Stop: cancel the request for real (ST keeps its partial text as usual).
        active = null;
        job.attached = false;
        removeJob(job).catch(() => { });
    });

    // First listener, so the marker is set before anything else (and before ST saves the chat).
    eventSource.makeFirst(event_types.MESSAGE_RECEIVED, (index, type) => {
        if (!['first_message', 'command', 'extension'].includes(type)) {
            // a generated reply: ST saves the chat right after this event
            expectSaveAfter = saveState.seq;
            expectSaveUntil = Date.now() + 2500;
        }
        const job = active;
        if (!job || type === 'impersonate') return;
        if (stFinishedNormally(job)) {
            consumed(job);
            return;
        }
        // ST stopped reading before the end: this is its partial message. Mark it so the full
        // reply can replace it later.
        if (markExistingMessage(Number(index), job.id)) job.markedHere = true;
        release(job);
    });

    eventSource.on(event_types.GENERATION_ENDED, () => {
        const job = active;
        if (!job) return;
        setTimeout(() => {
            if (active !== job) return;
            if (stFinishedNormally(job)) consumed(job);
            else release(job);
        }, 1500);
    });
}

/** Called by the controller if ST is idle but a job still looks attached. */
export function settleActive(isGeneratingNow) {
    const job = active;
    if (!job || isGeneratingNow) return;
    if (stFinishedNormally(job)) consumed(job);
    else release(job);
}

/**
 * ST read the reply to its end. (ST stops reading at the SSE "[DONE]" line, so the end of the
 * byte stream is not always observed; "nobody aborted and the stream did not fail" is the signal.)
 */
function stFinishedNormally(job) {
    if (job.stEof) return true;
    return !job.detachRequested && !job.stFailed && !job.stSignal?.aborted;
}

function consumed(job) {
    active = null;
    job.attached = false;
    log('reply delivered normally', job.id);
    removeJob(job).catch(() => { });
}

function release(job) {
    active = null;
    job.attached = false;
    job.local.detached = true;
    log('reply continues in the background', job.id);
    patchJob(job, { detached: true }).catch(() => { });
    onReleased(job);
}

function samePrompt(promptRef, messages) {
    if (!Array.isArray(promptRef) || !Array.isArray(messages)) return true;
    if (messages.some(m => promptRef.includes(m))) return true;
    return promptRef.length === messages.length;
}

function buildMeta(type, pipeline = false) {
    const chatKey = currentChatKey();
    if (!chatKey) return null;
    const forced = pipeline && genForceChid !== null && characters[genForceChid] ? characters[genForceChid] : null;
    const character = forced ?? characters[this_chid];
    let chatName = character?.name ?? '';
    if (chatKey.kind === 'group') {
        const group = groups.find(x => String(x.id) === String(selected_group));
        chatName = group?.name ?? 'Group';
    }
    let model = '';
    let apiName = '';
    try { model = getGeneratingModel(); } catch { /* ignore */ }
    try { apiName = getGeneratingApi(); } catch { /* ignore */ }
    return {
        v: 1,
        id: uid(),
        type,
        api: main_api,
        apiName,
        model,
        stream: !!isStreamingEnabled(),
        source: main_api === 'openai' ? oai_settings.chat_completion_source : textgenerationwebui_settings.type,
        chat: chatKey,
        chatName,
        speaker: character ? { name: character.name, avatar: character.avatar } : null,
        target: pipeline ? null : describeTarget(type),
        pipeline,
        ownerTab: TAB_ID,
        createdAt: Date.now(),
    };
}

/** Wraps the /gen command so its quiet generation can be recognised (see GENERATION_STARTED). */
function wrapGenCommand() {
    const command = window.SillyTavern?.getContext?.()?.SlashCommandParser?.commands?.gen;
    if (!command || typeof command.callback !== 'function') return false;
    if (command.callback.__bgrGen) return true;
    const inner = command.callback;
    const wrapped = function (...args) {
        genTicket = Date.now();
        const named = args[0] && typeof args[0] === 'object' ? args[0] : {};
        genTicketInfo = {
            ctrl: named._abortController ?? null,
            // "/gen lock=on" asks SillyTavern to keep the input locked: respect it
            lock: ['on', 'true', '1'].includes(String(named.lock ?? '').trim().toLowerCase()),
        };
        // /gen empties the chat input when it starts. A script released from the input (its first
        // /gen went to the background) must not wipe what the user is typing meanwhile.
        const textarea = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('send_textarea'));
        const keep = textarea && isReleasedRun(genTicketInfo.ctrl) ? textarea.value : '';
        const result = inner.apply(this, args);
        if (keep && textarea.value !== keep) {
            textarea.value = keep;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return result;
    };
    wrapped.__bgrGen = true;
    command.callback = wrapped;
    return true;
}

export function isGenOverrideInstalled() {
    return !!window.__genStreamingOverrideInstalled;
}

function installFetchWrapper() {
    const previous = window.fetch;
    window.fetch = async function bgReplyFetch(input, init) {
        let path = '';
        try {
            const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input?.url);
            path = url ? new URL(url, location.href).pathname : '';
        } catch { /* ignore */ }

        if (SAVE_URLS.has(path)) {
            saveState.seq++;
            saveState.pending++;
            try {
                return await previous.call(window, input, init);
            } finally {
                saveState.pending--;
            }
        }

        if (!GEN_URLS.has(path) || !init || typeof init.body !== 'string' || !init.body.includes('"__bgr":"')) {
            return previous.call(window, input, init);
        }

        const match = init.body.match(/,"__bgr":"([A-Za-z0-9_-]+)"/);
        if (!match) return previous.call(window, input, init);
        const cleanInit = { ...init, body: init.body.replace(match[0], '') };
        const meta = armed?.meta?.id === match[1] ? armed.meta : null;
        const genCall = meta ? armed.gen : null;
        armed = null;
        if (!meta) return previous.call(window, input, cleanInit);

        await backendReady;
        const job = createJob(meta);
        if (meta.pipeline) {
            try {
                return await startPipeline(job, path, cleanInit, genCall ?? {});
            } catch (error) {
                if (error?.name !== 'AbortError') {
                    warn('background /gen start failed', error);
                    forgetJob(job.id);
                }
                throw error;
            }
        }
        job.attached = true;
        job.stSignal = cleanInit.signal ?? null;
        active = job;
        try {
            return await startJob(job, path, cleanInit);
        } catch (error) {
            if (error?.name !== 'AbortError') {
                warn('background start failed', error);
                if (active === job) active = null;
                forgetJob(job.id);
            }
            throw error;
        }
    };
}
