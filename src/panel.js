// Settings drawer in the Extensions panel.

import { extensionTypes } from '../../../../extensions.js';
import { getCurrentUserHandle } from '../../../../user.js';
import { chat, saveChatConditional, addOneMessage, characters, this_chid } from '../../../../../script.js';
import { backend, detectBackend, removeJob, abortJob } from './backend.js';
import { allJobs, isFinished, onJobsChanged } from './jobs.js';
import { isChatOpen, chatKeyString } from './apply.js';
import { openFromDock, poll, stopJob } from './controller.js';
import { isGenOverrideInstalled } from './capture.js';
import { hasWaiter, stopPipeline } from './pipeline.js';
import { EXT_NAME, PLUGIN_VERSION_BUNDLED, escapeHtml, plainPreview } from './utils.js';
import { getMessageTimeStamp } from '../../../../RossAscends-mods.js';

let getSettings = () => ({});
let saveSettings = () => { };
let root = null;

function folderName() {
    const match = /\/third-party\/([^/]+)\//.exec(import.meta.url);
    return match ? decodeURIComponent(match[1]) : EXT_NAME;
}

function installPaths() {
    const folder = folderName();
    const type = extensionTypes?.[`third-party/${folder}`];
    const handle = (() => { try { return getCurrentUserHandle(); } catch { return 'default-user'; } })();
    const rel = type === 'global'
        ? `public/scripts/extensions/third-party/${folder}`
        : `data/${handle}/extensions/${folder}`;
    return {
        rel,
        win: `${rel.replaceAll('/', '\\')}\\install-plugin.bat`,
        cmd: `node "${rel}/installer/install.mjs"`,
    };
}

const STATUS_TEXT = {
    done: '도착',
    running: '생성 중',
    error: '실패',
    aborted: '중지됨',
    interrupted: '중단됨',
};

export function initPanel({ settings, save }) {
    getSettings = settings;
    saveSettings = save;
    const paths = installPaths();

    const html = `
    <div id="bgr-settings" class="bgr-settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>백그라운드 답장</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <div class="bgr-status" id="bgr-status"></div>

          <label class="checkbox_label"><input type="checkbox" data-key="enabled"> <span>사용 (생성 중에도 다른 채팅으로 이동 가능)</span></label>
          <label class="checkbox_label"><input type="checkbox" data-key="genBackground"> <span>/gen 명령도 백그라운드로 (스트리밍이 켜져 있으면 실시간 미리보기)</span></label>
          <label class="checkbox_label bgr-sub-option"><input type="checkbox" data-key="genFreeInput"> <span>/gen 생성 중에도 메시지·다른 명령 보내기 (결과는 다른 생성이 끝난 뒤 이어서 처리. <code>/gen lock=on</code>이면 예전처럼 잠금)</span></label>
          <div class="bgr-warn bgr-override-note" id="bgr-override-note" hidden>'/gen 스트리밍' 스크립트(JS-Slash-Runner)가 켜져 있어요. 그 스크립트를 거친 /gen은 생성 중 이동할 수 없어요. 이 확장이 /gen 실시간 미리보기와 백그라운드 처리를 대신하니 그 스크립트는 꺼 주세요.</div>
          <label class="checkbox_label"><input type="checkbox" data-key="livePreview"> <span>돌아왔을 때 생성 중인 답장 실시간 표시</span></label>
          <label class="checkbox_label"><input type="checkbox" data-key="showRunning"> <span>생성 중인 채팅도 알림 아이콘으로 표시</span></label>
          <label class="checkbox_label"><input type="checkbox" data-key="sound"> <span>답장 도착 알림음</span></label>
          <label class="checkbox_label"><input type="checkbox" data-key="titleBadge"> <span>탭 제목에 안 읽은 답장 수 표시</span></label>
          <label class="checkbox_label"><input type="checkbox" data-key="browserNotify"> <span>브라우저 알림 (다른 탭을 보고 있을 때)</span></label>
          <div class="bgr-row">
            <span>알림 위치</span>
            <select id="bgr-position" class="text_pole">
              <option value="right">오른쪽 아래</option>
              <option value="left">왼쪽 아래</option>
            </select>
          </div>

          <div class="bgr-section-title">진행 중 / 대기 중인 답장</div>
          <div id="bgr-jobs" class="bgr-jobs"></div>

          <div class="bgr-section-title">보관함 <small>(넣을 자리를 못 찾은 답장)</small></div>
          <div id="bgr-inbox" class="bgr-jobs"></div>

          <details class="bgr-install">
            <summary>서버 플러그인 설치 / 재설치 방법</summary>
            <p>서버 플러그인이 있으면 <b>새로고침, 브라우저 종료, 폰 화면 꺼짐</b> 중에도 답장이 계속 생성돼요.
               없으면 이 탭이 열려 있는 동안만 이어서 받아요 (채팅 이동은 가능).</p>
            <p><b>Windows</b>: SillyTavern 폴더에서 아래 파일을 더블클릭한 뒤 SillyTavern을 재시작하세요.</p>
            <div class="bgr-copy-row"><code id="bgr-path-win">${escapeHtml(paths.win)}</code><button type="button" class="menu_button bgr-copy" data-target="bgr-path-win" title="복사"><i class="fa-solid fa-copy"></i></button></div>
            <p><b>Mac / Linux / Termux</b>: SillyTavern 폴더에서 아래 명령을 실행한 뒤 재시작하세요.</p>
            <div class="bgr-copy-row"><code id="bgr-path-cmd">${escapeHtml(paths.cmd)}</code><button type="button" class="menu_button bgr-copy" data-target="bgr-path-cmd" title="복사"><i class="fa-solid fa-copy"></i></button></div>
            <p class="bgr-note">설치 스크립트는 플러그인을 <code>plugins/st-bg-reply</code>에 복사하고 <code>config.yaml</code>의 <code>enableServerPlugins</code>를 <code>true</code>로 바꿔요 (바꾸기 전에 백업을 만들어요).
               SillyTavern 업데이트(git pull / UpdateAndStart)로는 지워지지 않아요. SillyTavern을 새로 설치했거나 폴더를 옮겼다면 같은 파일을 다시 실행하면 돼요.</p>
            <div class="bgr-row"><button type="button" class="menu_button" id="bgr-recheck"><i class="fa-solid fa-rotate"></i> 플러그인 다시 확인</button></div>
          </details>
        </div>
      </div>
    </div>`;

    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    host?.insertAdjacentHTML('beforeend', html);
    root = document.getElementById('bgr-settings');
    if (!root) return;

    for (const input of root.querySelectorAll('input[type="checkbox"][data-key]')) {
        const key = input.dataset.key;
        input.checked = !!getSettings()[key];
        input.addEventListener('change', async () => {
            getSettings()[key] = input.checked;
            if (key === 'browserNotify' && input.checked && 'Notification' in window && Notification.permission === 'default') {
                try { await Notification.requestPermission(); } catch { /* ignore */ }
            }
            saveSettings();
            render();
        });
    }
    const position = root.querySelector('#bgr-position');
    position.value = getSettings().position || 'right';
    position.addEventListener('change', () => {
        getSettings().position = position.value;
        saveSettings();
        render();
    });

    root.addEventListener('click', async (event) => {
        const copy = event.target.closest('.bgr-copy');
        if (copy) {
            const text = root.querySelector(`#${copy.dataset.target}`)?.textContent ?? '';
            try {
                await navigator.clipboard.writeText(text);
                toastr.success('복사했어요');
            } catch {
                toastr.info(text);
            }
            return;
        }
        if (event.target.closest('#bgr-recheck')) {
            await detectBackend();
            poll();
            render();
            toastr.info(backend.mode === 'plugin' ? '서버 플러그인 연결됨' : '서버 플러그인을 찾지 못했어요');
            return;
        }
        const button = event.target.closest('[data-act]');
        if (!button) return;
        const job = allJobs().find(x => x.id === button.dataset.id);
        if (!job) return;
        switch (button.dataset.act) {
            case 'open':
                await openFromDock(job.meta.chat);
                break;
            case 'stop':
                await stopJob(job);
                break;
            case 'delete':
                if (hasWaiter(job)) {
                    // a /gen pipeline is still waiting for this: cancel it when its chat is open again
                    job.discardResult = true;
                    await stopPipeline(job);
                    poll();
                    break;
                }
                if (!isFinished(job)) await abortJob(job);
                await removeJob(job);
                break;
            case 'copy':
                try {
                    await navigator.clipboard.writeText(job.local?.text ?? '');
                    toastr.success('복사했어요');
                } catch {
                    toastr.error('복사하지 못했어요');
                }
                break;
            case 'append':
                await appendToCurrentChat(job);
                break;
        }
    });

    onJobsChanged(render);
    render();
    setInterval(render, 5000); // picks up scripts loaded later (e.g. the /gen override notice)
}

async function appendToCurrentChat(job) {
    if (!isChatOpen(job.meta.chat)) {
        toastr.info('먼저 이 답장의 채팅을 열어 주세요.');
        await openFromDock(job.meta.chat);
        return;
    }
    const text = job.local?.text ?? '';
    const character = characters[this_chid];
    const message = {
        name: job.meta.speaker?.name ?? character?.name ?? '',
        is_user: false,
        is_system: false,
        send_date: getMessageTimeStamp(),
        mes: text,
        extra: { api: job.meta.apiName, model: job.meta.model },
        swipe_id: 0,
        swipes: [text],
        swipe_info: [{ send_date: getMessageTimeStamp(), extra: {} }],
    };
    chat.push(message);
    addOneMessage(message);
    await saveChatConditional();
    await removeJob(job);
    toastr.success('채팅 끝에 추가했어요');
}

function jobRow(job, inbox) {
    const meta = job.meta;
    let name = meta.chat.kind === 'group' ? `${meta.chatName} · ${meta.speaker?.name ?? ''}` : (meta.speaker?.name ?? meta.chatName);
    if (meta.pipeline) name += ' · /gen';
    const status = inbox ? (job.local?.pipelineOrphan ? '/gen 결과' : '자리 없음') : (STATUS_TEXT[job.status] ?? job.status);
    const time = new Date(job.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const preview = inbox ? plainPreview(job.local?.text, 120) : (job.preview || '');
    const buttons = [];
    buttons.push(`<button type="button" class="menu_button" data-act="open" data-id="${job.id}" title="채팅 열기"><i class="fa-solid fa-arrow-up-right-from-square"></i></button>`);
    if (inbox) {
        buttons.push(`<button type="button" class="menu_button" data-act="copy" data-id="${job.id}" title="텍스트 복사"><i class="fa-solid fa-copy"></i></button>`);
        buttons.push(`<button type="button" class="menu_button" data-act="append" data-id="${job.id}" title="그 채팅 끝에 추가"><i class="fa-solid fa-plus"></i></button>`);
    } else if (!isFinished(job)) {
        buttons.push(`<button type="button" class="menu_button" data-act="stop" data-id="${job.id}" title="생성 중지 (받은 부분까지 넣어요)"><i class="fa-solid fa-stop"></i></button>`);
    }
    buttons.push(`<button type="button" class="menu_button" data-act="delete" data-id="${job.id}" title="버리기"><i class="fa-solid fa-trash-can"></i></button>`);
    return `
      <div class="bgr-job bgr-st-${escapeHtml(job.status)}">
        <div class="bgr-job-main">
          <div class="bgr-job-line"><b>${escapeHtml(name)}</b><span class="bgr-chip">${escapeHtml(status)}</span><small>${escapeHtml(time)}</small></div>
          ${preview ? `<div class="bgr-job-preview">${escapeHtml(preview)}</div>` : ''}
        </div>
        <div class="bgr-job-buttons">${buttons.join('')}</div>
      </div>`;
}

function render() {
    if (!root) return;
    const note = root.querySelector('#bgr-override-note');
    if (note) note.hidden = !(isGenOverrideInstalled() && getSettings().genBackground !== false);
    const status = root.querySelector('#bgr-status');
    if (backend.mode === 'plugin') {
        const outdated = backend.plugin && backend.plugin.version !== PLUGIN_VERSION_BUNDLED;
        status.className = 'bgr-status bgr-ok';
        status.innerHTML = `<i class="fa-solid fa-circle-check"></i> 서버 플러그인 연결됨 (v${escapeHtml(backend.plugin?.version ?? '?')}) — 새로고침/창 닫기에도 답장이 이어져요.`
            + (outdated ? `<div class="bgr-warn">확장에 들어있는 플러그인은 v${PLUGIN_VERSION_BUNDLED}이에요. 설치 스크립트를 다시 실행하고 재시작하면 업데이트돼요.</div>` : '')
            + (backend.pluginError === 'loopback' ? '<div class="bgr-warn">플러그인이 SillyTavern에 내부 연결을 하지 못해 이 탭에서 대신 처리했어요. 콘솔 로그를 확인해 주세요.</div>' : '');
    } else if (backend.mode === 'local') {
        status.className = 'bgr-status bgr-local';
        status.innerHTML = backend.pluginError === 'protocol'
            ? '<i class="fa-solid fa-triangle-exclamation"></i> 서버 플러그인 버전이 맞지 않아요. 아래 설치 스크립트를 다시 실행하고 재시작해 주세요. 지금은 브라우저 모드로 동작해요.'
            : '<i class="fa-solid fa-circle-info"></i> 브라우저 모드 — 채팅 이동과 동시 생성은 되지만, 새로고침하면 생성 중이던 답장은 받은 부분까지만 남아요. 서버 플러그인을 설치하면 해결돼요.';
    } else {
        status.className = 'bgr-status';
        status.textContent = '확인 중…';
    }

    const jobs = allJobs().filter(job => !job.attached && !job.handledByST && !(job.delivered && !job.local?.detached));
    const active = jobs.filter(job => !job.local?.unplaced);
    const inbox = jobs.filter(job => job.local?.unplaced);
    root.querySelector('#bgr-jobs').innerHTML = active.length
        ? active.map(job => jobRow(job, false)).join('')
        : '<div class="bgr-empty">없음</div>';
    root.querySelector('#bgr-inbox').innerHTML = inbox.length
        ? inbox.map(job => jobRow(job, true)).join('')
        : '<div class="bgr-empty">비어 있음</div>';
}

export function renderPanel() {
    render();
}

export function chatLabel(key) {
    return chatKeyString(key);
}
