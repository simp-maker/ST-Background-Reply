// Leaving a chat while it is generating, and opening chats from notifications.

import {
    characters,
    this_chid,
    isGenerating,
    stopGeneration,
    selectCharacterById,
    openCharacterChat,
} from '../../../../../script.js';
import { selected_group, groups, openGroupById, openGroupChat } from '../../../../group-chats.js';
import * as script from '../../../../../script.js';
import { getActiveJob, isSaveExpected, saveState, settleActive } from './capture.js';
import { isChatOpen } from './apply.js';
import { getAttachedPipeline, suspendAttached } from './pipeline.js';
import { delay, waitFor, log } from './utils.js';

// Things that switch (or close / replace) the current chat.
const SWITCH_SELECTOR = [
    '.character_select',
    '.group_select',
    '.select_chat_block',
    '.mes_bookmark',
    '#option_select_chat',
    '#option_start_new_chat',
    '#option_close_chat',
    '#option_back_to_main',
    '#option_convert_to_group',
    '.recentChat',
].join(', ');

let getSettings = () => ({ enabled: true });
let isApplyBusy = () => false;
let waitApplyIdle = async () => { };
let switching = false;

export function initNav({ settings, applyBusy, applyIdle }) {
    getSettings = settings;
    isApplyBusy = applyBusy;
    waitApplyIdle = applyIdle;
    document.addEventListener('click', onClickCapture, true);
}

function isChatSavingNow() {
    try { return !!script.isChatSaving; } catch { return false; }
}

/**
 * Lets SillyTavern stop waiting for the current reply while the request keeps running.
 * @returns {Promise<boolean>} true if ST is now free
 */
export async function detachActive() {
    const job = getActiveJob();
    if (!job) return !isGenerating();
    job.detachRequested = true;
    log('detaching', job.id);
    const saveSeq = saveState.seq;
    stopGeneration();
    await waitFor(() => !isGenerating(), 20000);
    // ST finalizes its partial message (we mark it) and then saves the chat. Switching before that
    // save finishes would make ST save into the chat we switch to.
    await waitFor(() => getActiveJob() !== job, 2000);
    if (getActiveJob() === job) settleActive(false);
    if (job.markedHere) await waitFor(() => saveState.seq > saveSeq, 4000);
    await waitFor(() => saveState.pending === 0 && !isChatSavingNow(), 20000);
    await delay(30);
    await waitApplyIdle();
    return !isGenerating();
}

function isSameTarget(el) {
    if (el.matches('.character_select')) {
        const chid = el.getAttribute('data-chid') ?? el.getAttribute('chid');
        return !selected_group && chid !== null && String(chid) === String(this_chid);
    }
    if (el.matches('.group_select')) {
        const grid = el.getAttribute('data-chid') || el.getAttribute('data-grid') || el.getAttribute('grid');
        return !!selected_group && String(grid) === String(selected_group);
    }
    return false;
}

function findAgain(el) {
    if (el.isConnected) return el;
    const chid = el.getAttribute('data-chid');
    if (el.matches('.character_select') && chid !== null) {
        return document.querySelector(`.character_select[data-chid="${CSS.escape(chid)}"]`);
    }
    const grid = el.getAttribute('data-grid') || el.getAttribute('data-chid');
    if (el.matches('.group_select') && grid) {
        return document.querySelector(`.group_select[data-grid="${CSS.escape(grid)}"], .group_select[data-chid="${CSS.escape(grid)}"]`);
    }
    if (el.id) return document.getElementById(el.id);
    return null;
}

async function onClickCapture(event) {
    if (switching) return;
    const target = event.target instanceof Element ? event.target.closest(SWITCH_SELECTOR) : null;
    if (!target) return;
    if (event.shiftKey && target.matches('.mes_bookmark')) return; // shift+click creates a bookmark

    const enabled = getSettings().enabled;
    const needsDetach = enabled && isGenerating() && !!getActiveJob() && !isSameTarget(target);
    const needsSuspend = enabled && isGenerating() && !getActiveJob() && !!getAttachedPipeline() && !isSameTarget(target);
    const needsWait = isApplyBusy() || (!isGenerating() && !isSameTarget(target) && isSaveExpected());
    if (!needsDetach && !needsSuspend && !needsWait) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    switching = true;
    try {
        if (needsDetach) await detachActive();
        if (needsSuspend) suspendAttached();
        await waitFor(() => !isSaveExpected() && !isChatSavingNow(), 5000);
        await waitApplyIdle();
        const again = findAgain(target);
        if (again) {
            // re-dispatch the same click now that nothing blocks the switch
            switching = false;
            again.click();
        }
    } finally {
        switching = false;
    }
}

/**
 * Opens the chat a job belongs to.
 * @param {{kind:string, avatar?:string, groupId?:string, chatId:string}} key
 * @returns {Promise<boolean>}
 */
export async function openChat(key) {
    if (!key) return false;
    if (isChatOpen(key)) return true;

    if (isGenerating()) {
        if (getActiveJob()) {
            await detachActive();
        } else if (getAttachedPipeline()) {
            suspendAttached();
        } else {
            toastr.info('지금 생성 중인 답장이 끝난 뒤에 이동할 수 있어요.', '백그라운드 답장');
            return false;
        }
    }
    await waitApplyIdle();

    try {
        if (key.kind === 'group') {
            const group = groups.find(x => String(x.id) === String(key.groupId));
            if (!group) {
                toastr.warning('그룹을 찾을 수 없어요. 삭제되었을 수 있어요.', '백그라운드 답장');
                return false;
            }
            if (String(selected_group) !== String(key.groupId)) await openGroupById(key.groupId);
            if (String(group.chat_id) !== String(key.chatId)) {
                if (!group.chats?.includes?.(key.chatId)) {
                    toastr.warning('채팅 파일을 찾을 수 없어요. 이름이 바뀌었거나 삭제되었을 수 있어요.', '백그라운드 답장');
                    return false;
                }
                await openGroupChat(key.groupId, key.chatId);
            }
        } else {
            const index = characters.findIndex(x => x.avatar === key.avatar);
            if (index < 0) {
                toastr.warning('캐릭터를 찾을 수 없어요. 삭제되었을 수 있어요.', '백그라운드 답장');
                return false;
            }
            if (selected_group || String(this_chid) !== String(index)) {
                await selectCharacterById(index, { switchMenu: false });
            }
            if (String(characters[index]?.chat) !== String(key.chatId)) {
                await openCharacterChat(key.chatId);
            }
        }
    } catch (error) {
        console.error('[BgReply] could not open chat', error);
        return false;
    }
    return isChatOpen(key);
}
