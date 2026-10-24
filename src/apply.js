// Putting background replies into the chat that is currently open.
//
// Every job gets a "marker" in the chat ({extra.bg_reply: {id}} on the message, and on the
// matching swipe_info entry). The marker is either set on SillyTavern's own partial message
// when we detach (chat switch), or on a placeholder message/swipe we add when the chat is
// opened later (e.g. after a reload). When the job finishes, the marked message/swipe gets
// the final text — wherever it is now, even if more messages were added after it.

import {
    chat,
    characters,
    this_chid,
    addOneMessage,
    updateMessageBlock,
    updateSwipeCounter,
    ensureSwipes,
    syncMesToSwipe,
    syncSwipeToMes,
    cleanUpMessage,
    getThumbnailUrl,
    deleteMessage,
    saveChatConditional,
    messageFormatting,
} from '../../../../../script.js';
import { eventSource, event_types } from '../../../../events.js';
import { selected_group, groups } from '../../../../group-chats.js';
import { getRegexedString, regex_placement } from '../../../../extensions/regex/engine.js';
import { power_user } from '../../../../power-user.js';
import { getMessageTimeStamp } from '../../../../RossAscends-mods.js';
import { MARK, hash } from './utils.js';

// ---------------------------------------------------------------------------
// Chat identity

export function currentChatKey() {
    if (selected_group) {
        const group = groups.find(x => String(x.id) === String(selected_group));
        if (!group) return null;
        return { kind: 'group', groupId: String(group.id), chatId: String(group.chat_id) };
    }
    if (this_chid !== undefined && this_chid !== null && characters[this_chid]) {
        const character = characters[this_chid];
        return { kind: 'char', avatar: character.avatar, chatId: String(character.chat) };
    }
    return null;
}

export function sameChat(a, b) {
    if (!a || !b || a.kind !== b.kind || String(a.chatId) !== String(b.chatId)) return false;
    return a.kind === 'group' ? String(a.groupId) === String(b.groupId) : a.avatar === b.avatar;
}

export function chatKeyString(key) {
    return key ? `${key.kind}|${key.kind === 'group' ? key.groupId : key.avatar}|${key.chatId}` : '';
}

export function isChatOpen(key) {
    return sameChat(currentChatKey(), key);
}

// ---------------------------------------------------------------------------
// Fingerprints (used to find where a reply belongs when no marker exists)

export function fpStrict(msg) {
    return hash([msg?.is_user ? 1 : 0, msg?.name ?? '', msg?.send_date ?? '', msg?.mes ?? ''].join('\u0001'));
}

export function fpLoose(msg) {
    return hash([msg?.is_user ? 1 : 0, msg?.name ?? '', msg?.send_date ?? ''].join('\u0001'));
}

function firstSwipeText(msg) {
    return Array.isArray(msg?.swipes) && typeof msg.swipes[0] === 'string' ? msg.swipes[0] : (msg?.mes ?? '');
}

/** Builds the "where does the reply go" part of a job, at the moment the request is sent. */
export function describeTarget(type) {
    const last = chat[chat.length - 1];
    switch (type) {
        case 'swipe':
            return {
                index: chat.length - 1,
                swipe: Number(last?.swipe_id ?? 1),
                name: last?.name ?? '',
                fp0: hash(firstSwipeText(last)),
            };
        case 'continue': {
            const text = String(last?.mes ?? '');
            return {
                index: chat.length - 1,
                swipe: Number(last?.swipe_id ?? 0),
                name: last?.name ?? '',
                baseLen: text.length,
                baseHash: hash(text),
            };
        }
        default:
            return {
                index: chat.length,
                anchor: last ? { strict: fpStrict(last), loose: fpLoose(last) } : null,
            };
    }
}

// ---------------------------------------------------------------------------
// Markers

function setMarker(msg, swipe, jobId) {
    const mark = { id: jobId };
    if (Array.isArray(msg.swipe_info) && msg.swipe_info[swipe]) {
        msg.swipe_info[swipe].extra ??= {};
        msg.swipe_info[swipe].extra[MARK] = mark;
    }
    if ((msg.swipe_id ?? 0) === swipe) {
        msg.extra ??= {};
        msg.extra[MARK] = mark;
    }
}

function clearMarker(msg, jobId) {
    if (msg?.extra?.[MARK]?.id === jobId) delete msg.extra[MARK];
    if (Array.isArray(msg?.swipe_info)) {
        for (const info of msg.swipe_info) {
            if (info?.extra?.[MARK]?.id === jobId) delete info.extra[MARK];
        }
    }
}

/** @returns {{index: number, swipe: number}|null} */
export function findMarker(jobId) {
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (!msg) continue;
        if (Array.isArray(msg.swipe_info)) {
            for (let s = 0; s < msg.swipe_info.length; s++) {
                if (msg.swipe_info[s]?.extra?.[MARK]?.id === jobId) return { index: i, swipe: s };
            }
        }
        if (msg.extra?.[MARK]?.id === jobId) return { index: i, swipe: Number(msg.swipe_id ?? 0) };
    }
    return null;
}

export function markerIdsInChat() {
    const ids = new Set();
    for (const msg of chat) {
        if (msg?.extra?.[MARK]?.id) ids.add(msg.extra[MARK].id);
        if (Array.isArray(msg?.swipe_info)) {
            for (const info of msg.swipe_info) {
                if (info?.extra?.[MARK]?.id) ids.add(info.extra[MARK].id);
            }
        }
    }
    return ids;
}

/** Marks SillyTavern's own (partial) message after we detached it. */
export function markExistingMessage(index, jobId) {
    const msg = chat[index];
    if (!msg || msg.is_user) return false;
    ensureSwipes(msg);
    setMarker(msg, Number(msg.swipe_id ?? 0), jobId);
    return true;
}

// ---------------------------------------------------------------------------
// Placement of jobs that have no marker yet

function findFromEnd(predicate) {
    for (let i = chat.length - 1; i >= 0; i--) {
        if (predicate(chat[i], i)) return i;
    }
    return -1;
}

function isReplyMessage(msg) {
    return !!msg && !msg.is_user && !msg.is_system && !msg.extra?.isSmallSys;
}

function locate(job) {
    const { type, target } = job.meta;
    if (type === 'swipe') {
        return findFromEnd(m => isReplyMessage(m) && (m.name ?? '') === target.name && hash(firstSwipeText(m)) === target.fp0);
    }
    if (type === 'continue') {
        return findFromEnd((m) => {
            if (!isReplyMessage(m)) return false;
            const text = String(m.mes ?? '');
            return text.length >= target.baseLen && hash(text.slice(0, target.baseLen)) === target.baseHash;
        });
    }
    if (!target.anchor) return chat.length - 1;
    let a = findFromEnd(m => fpStrict(m) === target.anchor.strict);
    if (a < 0) a = findFromEnd(m => fpLoose(m) === target.anchor.loose);
    return a < 0 ? -2 : a;
}

function newPlaceholderMessage(job) {
    const { speaker, chat: chatKey } = job.meta;
    const now = getMessageTimeStamp();
    const started = new Date(job.createdAt);
    const msg = {
        name: speaker?.name ?? '',
        is_user: false,
        is_system: false,
        send_date: now,
        mes: '...',
        extra: { api: job.meta.apiName, model: job.meta.model },
        gen_started: started,
        gen_finished: null,
        swipe_id: 0,
        swipes: ['...'],
        swipe_info: [{ send_date: now, gen_started: started, gen_finished: null, extra: { api: job.meta.apiName, model: job.meta.model } }],
    };
    if (chatKey.kind === 'group' && speaker?.avatar) {
        msg.force_avatar = getThumbnailUrl('avatar', speaker.avatar);
        msg.original_avatar = speaker.avatar;
    }
    return msg;
}

function appendPlaceholder(job) {
    const msg = newPlaceholderMessage(job);
    setMarker(msg, 0, job.id);
    chat.push(msg);
    addOneMessage(msg, { scroll: false });
    return { index: chat.length - 1, swipe: 0 };
}

function addSwipePlaceholder(job, index, { activate, preferSlot = null }) {
    const msg = chat[index];
    ensureSwipes(msg);
    let slot = -1;
    if (preferSlot !== null && preferSlot < msg.swipes.length && ['', '...'].includes(msg.swipes[preferSlot]) && !msg.swipe_info[preferSlot]?.extra?.[MARK]) {
        slot = preferSlot;
    } else {
        slot = msg.swipes.length;
        msg.swipes.push('...');
        msg.swipe_info.push({
            send_date: getMessageTimeStamp(),
            gen_started: new Date(job.createdAt),
            gen_finished: null,
            extra: { api: job.meta.apiName, model: job.meta.model },
        });
    }
    if (activate && msg.swipe_id !== slot) {
        syncMesToSwipe(index);
        syncSwipeToMes(index, slot);
    }
    setMarker(msg, slot, job.id);
    updateMessageBlock(index, msg);
    updateSwipeCounter(index);
    return { index, swipe: slot };
}

/** ST's own partial copy of this reply (saved without our marker): its text is the start of ours. */
function isPartialOf(msg, text) {
    const partial = String(msg?.mes ?? '').trim();
    return !!text && partial.length > 0 && partial !== '...' && String(text).startsWith(partial);
}

function adoptActiveSwipe(index, jobId) {
    const msg = chat[index];
    ensureSwipes(msg);
    const slot = Number(msg.swipe_id ?? 0);
    setMarker(msg, slot, jobId);
    return { index, swipe: slot };
}

/**
 * Adds a placeholder for a job that has no marker in the open chat.
 * @param {any} job
 * @param {string} [text] Reply text known so far (lets us take over ST's own unmarked partial message)
 * @returns {{index: number, swipe: number}|null} null if we can't tell where it belongs.
 */
export function placeJob(job, text = '') {
    const at = locate(job);
    if (job.meta.type === 'swipe') {
        if (at < 0) return null;
        const msg = chat[at];
        if (Number(msg.swipe_id ?? 0) === job.meta.target.swipe && isPartialOf(msg, text)) return adoptActiveSwipe(at, job.id);
        return addSwipePlaceholder(job, at, { activate: at === chat.length - 1, preferSlot: job.meta.target.swipe });
    }
    if (job.meta.type === 'continue') {
        if (at < 0) return null;
        const msg = chat[at];
        ensureSwipes(msg);
        setMarker(msg, Number(msg.swipe_id ?? 0), job.id);
        return { index: at, swipe: Number(msg.swipe_id ?? 0) };
    }
    // normal / regenerate
    if (at === -2) return null;
    const next = chat[at + 1];
    if (!next) return appendPlaceholder(job);
    if (isReplyMessage(next) && isPartialOf(next, text)) return adoptActiveSwipe(at + 1, job.id);
    if (isReplyMessage(next)) return addSwipePlaceholder(job, at + 1, { activate: false });
    return appendPlaceholder(job); // the conversation went on: add it at the end
}

/** True if the open chat already contains this reply (e.g. SillyTavern saved it before a reload). */
export function alreadyInChat(job, text) {
    if (!text) return false;
    const at = locate(job);
    if (job.meta.type === 'continue') {
        const mes = String(chat[at]?.mes ?? '');
        return at >= 0 && mes.length > job.meta.target.baseLen && mes.endsWith(text);
    }
    if (at < 0 && job.meta.type === 'swipe') return false;
    const candidates = job.meta.type === 'swipe' ? [chat[at]] : [chat[at + 1]];
    return candidates.some(m => isReplyMessage(m) && (m.mes === text || (Array.isArray(m.swipes) && m.swipes.includes(text))));
}

// ---------------------------------------------------------------------------
// Turning the parsed reply into final message text (same steps as SillyTavern)

export function processResult(job, parsed) {
    const isContinue = job.meta.type === 'continue';
    let text = cleanUpMessage({
        getMessage: parsed.text || '',
        isImpersonate: false,
        isContinue,
        displayIncompleteSentences: false,
    });
    if (!isContinue && power_user.trim_spaces) text = text.trim();
    let reasoning = parsed.reasoning || '';
    if (reasoning) {
        reasoning = getRegexedString(reasoning, regex_placement.REASONING);
        if (power_user.trim_spaces) reasoning = reasoning.trim();
    }
    return { text, reasoning };
}

// ---------------------------------------------------------------------------
// Filling and removing

export function removeLiveBadge(index) {
    const el = document.querySelector(`#chat .mes[mesid="${index}"] .bgr-live`);
    el?.remove();
    document.querySelector(`#chat .mes[mesid="${index}"]`)?.classList.remove('bgr-generating');
}

/**
 * Writes the final reply into the marked message / swipe and saves the chat.
 * @returns {Promise<{index:number, swipe:number}|null>}
 */
export async function fillJob(job, loc, { text, reasoning }) {
    const msg = chat[loc.index];
    if (!msg) return null;
    ensureSwipes(msg);
    let slot = loc.swipe;
    while (slot >= msg.swipes.length) {
        msg.swipes.push('');
        msg.swipe_info.push({ send_date: getMessageTimeStamp(), extra: {} });
    }

    let finalText = text;
    if (job.meta.type === 'continue') {
        const current = String(msg.swipes[slot] ?? msg.mes ?? '');
        const base = current.slice(0, job.meta.target.baseLen);
        if (hash(base) === job.meta.target.baseHash) {
            finalText = base + text;
        } else {
            // The message was edited meanwhile: keep the edit and add the continued version as a new swipe.
            clearMarker(msg, job.id);
            slot = msg.swipes.length;
            msg.swipes.push('');
            msg.swipe_info.push({ send_date: getMessageTimeStamp(), extra: {} });
            finalText = current + text;
        }
    }

    const finished = new Date(job.finishedAt || Date.now());
    const extraPatch = {
        api: job.meta.apiName,
        model: job.meta.model,
        reasoning: reasoning || '',
        reasoning_duration: null,
    };

    clearMarker(msg, job.id);
    const info = msg.swipe_info[slot] ?? (msg.swipe_info[slot] = { extra: {} });
    info.send_date ??= getMessageTimeStamp();
    info.gen_started ??= new Date(job.createdAt);
    info.gen_finished = finished;
    info.extra = { ...(info.extra || {}), ...extraPatch };
    delete info.extra[MARK];
    msg.swipes[slot] = finalText;

    const isActive = Number(msg.swipe_id ?? 0) === slot;
    if (isActive) {
        msg.mes = finalText;
        msg.extra = { ...(msg.extra || {}), ...extraPatch };
        delete msg.extra[MARK];
        msg.gen_started = info.gen_started;
        msg.gen_finished = finished;
        removeLiveBadge(loc.index);
        // Lets other extensions (and ST's reasoning auto-parse) react like for a normal reply.
        await eventSource.emit(event_types.MESSAGE_RECEIVED, loc.index, job.meta.type);
        if (chat[loc.index] === msg) {
            syncMesToSwipe(loc.index);
            updateMessageBlock(loc.index, msg);
            await updateSwipeCounter(loc.index);
            await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, loc.index, job.meta.type);
        }
    } else {
        removeLiveBadge(loc.index);
        await updateSwipeCounter(loc.index);
    }
    await saveChatConditional();
    return { index: chat.indexOf(msg), swipe: slot };
}

/** Removes a placeholder that never got any text. Keeps ST's own partial text if there is some. */
export async function discardPlaceholder(job, loc) {
    const msg = chat[loc.index];
    if (!msg) return;
    const text = Array.isArray(msg.swipes) ? msg.swipes[loc.swipe] : msg.mes;
    clearMarker(msg, job.id);
    removeLiveBadge(loc.index);
    if (text === '...' || text === '' || text === undefined) {
        if (Array.isArray(msg.swipes) && msg.swipes.length > 1) {
            await deleteMessage(loc.index, loc.swipe, false);
        } else {
            await deleteMessage(loc.index, undefined, false);
        }
        return;
    }
    await saveChatConditional();
}

// ---------------------------------------------------------------------------
// Live preview of a running job in the open chat

/**
 * @param {any} job
 * @param {{index:number, swipe:number}} loc
 * @param {string} rawText Text received so far
 * @param {(job:any)=>void} onStop
 */
export function showLive(job, loc, rawText, onStop) {
    const element = document.querySelector(`#chat .mes[mesid="${loc.index}"]`);
    const msg = chat[loc.index];
    if (!element || !msg) return;
    element.classList.add('bgr-generating');

    if (Number(msg.swipe_id ?? 0) === loc.swipe && rawText) {
        const isContinue = job.meta.type === 'continue';
        let shown = cleanUpMessage({
            getMessage: rawText,
            isImpersonate: false,
            isContinue,
            displayIncompleteSentences: true,
        });
        if (isContinue) {
            shown = String(msg.mes ?? '').slice(0, job.meta.target.baseLen) + shown;
        }
        const textElement = element.querySelector('.mes_text');
        if (textElement) {
            textElement.innerHTML = messageFormatting(shown, msg.name, false, false, loc.index, {}, false);
        }
    }

    let badge = element.querySelector('.bgr-live');
    if (!badge || badge.dataset.job !== job.id) {
        badge?.remove();
        badge = document.createElement('div');
        badge.className = 'bgr-live';
        badge.dataset.job = job.id;
        badge.innerHTML = '<span class="bgr-live-dot"></span><span class="bgr-live-text">백그라운드에서 답장 생성 중</span><button type="button" class="bgr-live-stop menu_button" title="이 답장 생성을 멈춥니다">중지</button>';
        badge.querySelector('.bgr-live-stop').addEventListener('click', (event) => {
            event.stopPropagation();
            onStop(job);
        });
        const anchor = element.querySelector('.mes_text');
        if (anchor) anchor.after(badge);
        else element.querySelector('.mes_block')?.append(badge);
    }
    alignWithText(badge, element.querySelector('.mes_text'));
}

/**
 * Lines the badge up with where the message text starts, whatever padding/border/margin the
 * theme gives .mes_text (themes without any keep a zero offset, so nothing changes for them).
 */
function alignWithText(badge, textElement) {
    if (!badge || !textElement) return;
    badge.style.marginLeft = '0px';
    const textRect = textElement.getBoundingClientRect();
    const badgeRect = badge.getBoundingClientRect();
    if (!textRect.width || !badgeRect.width) return;
    const cs = getComputedStyle(textElement);
    const textStart = textRect.left + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0);
    const offset = Math.round(textStart - badgeRect.left);
    if (offset > 0 && offset < textRect.width) badge.style.marginLeft = `${offset}px`;
}

export function scrollToMessage(index) {
    const element = document.querySelector(`#chat .mes[mesid="${index}"]`);
    element?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    element?.classList.add('bgr-flash');
    setTimeout(() => element?.classList.remove('bgr-flash'), 1600);
}
