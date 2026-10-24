// KakaoTalk-style chat bubbles in the corner: bot avatar + red unread count.

import { getThumbnailUrl } from '../../../../../script.js';
import { allJobs, isFinished, isReceived } from './jobs.js';
import { chatKeyString } from './apply.js';
import { escapeHtml } from './utils.js';

let getSettings = () => ({});
let isNotifiable = (_job) => false;
let onOpen = async (_key) => { };
let onDismiss = async (_jobs) => { };
let dock = null;
const TITLE_RE = /^\(\d+\)\s/;
const lastCounts = new Map();

export function initNotify({ settings, notifiable, open, dismiss }) {
    getSettings = settings;
    isNotifiable = notifiable;
    onOpen = open;
    onDismiss = dismiss;

    dock = document.createElement('div');
    dock.id = 'bgr-dock';
    dock.setAttribute('aria-live', 'polite');
    document.body.append(dock);

    window.addEventListener('resize', position);
    setInterval(position, 2000);
    position();
}

function avatarUrl(job) {
    const avatar = job.meta?.speaker?.avatar;
    if (!avatar || avatar === 'none') return 'img/ai4.png';
    try { return getThumbnailUrl('avatar', avatar); } catch { return 'img/ai4.png'; }
}

export function position() {
    if (!dock) return;
    const settings = getSettings();
    dock.classList.toggle('bgr-left', settings.position === 'left');
    const form = document.getElementById('form_sheld');
    const sheld = document.getElementById('sheld');
    const formTop = form?.getBoundingClientRect().top ?? (window.innerHeight - 70);
    // Positioned from the top: on mobile layouts ST gives <html> a transform, which makes
    // "position: fixed; bottom: …" measure from a zero-height box instead of the viewport.
    const top = Math.max(8, formTop - 12 - dock.offsetHeight);
    dock.style.top = `${top}px`;
    dock.style.bottom = '';
    const rect = sheld?.getBoundingClientRect();
    if (settings.position === 'left') {
        dock.style.left = `${Math.max(8, (rect?.left ?? 0) + 12)}px`;
        dock.style.right = '';
    } else {
        dock.style.right = `${Math.max(8, window.innerWidth - (rect?.right ?? window.innerWidth) + 12)}px`;
        dock.style.left = '';
    }
}

/** Groups notifiable jobs by chat. */
export function collectEntries() {
    const entries = new Map();
    for (const job of allJobs()) {
        if (!isNotifiable(job)) continue;
        const key = chatKeyString(job.meta.chat);
        let entry = entries.get(key);
        if (!entry) {
            entry = { key, chat: job.meta.chat, jobs: [], finished: 0, running: 0, failed: 0, latest: job };
            entries.set(key, entry);
        }
        entry.jobs.push(job);
        if (isReceived(job)) {
            if (job.preview || job.status === 'done') entry.finished++;
            else entry.failed++;
        } else {
            entry.running++;
        }
        if ((job.finishedAt || job.createdAt) >= (entry.latest.finishedAt || entry.latest.createdAt)) entry.latest = job;
    }
    return [...entries.values()];
}

export function render() {
    if (!dock) return;
    const settings = getSettings();
    const entries = settings.showDock === false ? [] : collectEntries();
    const seen = new Set();

    for (const entry of entries) {
        seen.add(entry.key);
        let bubble = dock.querySelector(`.bgr-bubble[data-key="${CSS.escape(entry.key)}"]`);
        if (!bubble) {
            bubble = document.createElement('div');
            bubble.className = 'bgr-bubble bgr-pop';
            bubble.dataset.key = entry.key;
            bubble.tabIndex = 0;
            bubble.setAttribute('role', 'button');
            bubble.innerHTML = `
                <div class="bgr-avatar"><img alt="" draggable="false"></div>
                <span class="bgr-badge"></span>
                <div class="bgr-tip"><b class="bgr-tip-name"></b><span class="bgr-tip-text"></span></div>
                <button type="button" class="bgr-close" title="알림 숨기기 (답장은 채팅을 열면 들어가 있어요)">×</button>`;
            bubble.addEventListener('click', (event) => {
                if (event.target.closest('.bgr-close')) return;
                const current = bubble.__entry;
                if (current) onOpen(current.chat);
            });
            bubble.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    if (bubble.__entry) onOpen(bubble.__entry.chat);
                }
            });
            bubble.querySelector('.bgr-close').addEventListener('click', (event) => {
                event.stopPropagation();
                if (bubble.__entry) onDismiss(bubble.__entry.jobs);
            });
            setTimeout(() => bubble.classList.remove('bgr-pop'), 400);
            dock.append(bubble);
        }
        bubble.__entry = entry;
        const img = bubble.querySelector('img');
        const src = avatarUrl(entry.latest);
        if (img.getAttribute('src') !== src) img.setAttribute('src', src);

        const badge = bubble.querySelector('.bgr-badge');
        if (entry.finished > 0) {
            badge.textContent = entry.finished > 99 ? '99+' : String(entry.finished);
            badge.hidden = false;
            badge.classList.remove('bgr-badge-warn');
        } else if (entry.failed > 0) {
            badge.textContent = '!';
            badge.hidden = false;
            badge.classList.add('bgr-badge-warn');
        } else {
            badge.hidden = true;
        }
        bubble.classList.toggle('bgr-running', entry.running > 0);

        const meta = entry.latest.meta;
        let name = entry.chat.kind === 'group'
            ? `${meta.chatName || '그룹'} · ${meta.speaker?.name ?? ''}`
            : (meta.speaker?.name || meta.chatName || '');
        if (meta.pipeline) name += ' (/gen)';
        let text;
        if (entry.finished > 0 && entry.latest.preview) text = entry.latest.preview;
        else if (entry.running > 0) text = meta.pipeline ? '/gen 결과를 받는 중… (돌아가면 이어서 진행해요)' : '답장을 쓰는 중…';
        else if (entry.failed > 0) text = entry.latest.error ? `생성 실패: ${entry.latest.error}` : '생성 실패';
        else text = '새 답장';
        bubble.querySelector('.bgr-tip-name').textContent = name;
        bubble.querySelector('.bgr-tip-text').textContent = text;
        bubble.setAttribute('aria-label', `${name}: ${text}`);

        // A new reply arrived in this chat: show the preview for a few seconds, like a messenger.
        const latest = entry.latest;
        if (isReceived(latest) && latest.preview && lastCounts.get(entry.key) !== latest.id) {
            lastCounts.set(entry.key, latest.id);
            bubble.classList.add('bgr-show-tip');
            clearTimeout(bubble.__tipTimer);
            bubble.__tipTimer = setTimeout(() => bubble.classList.remove('bgr-show-tip'), 4500);
        }
    }
    for (const key of [...lastCounts.keys()]) {
        if (!seen.has(key)) lastCounts.delete(key);
    }

    for (const bubble of [...dock.querySelectorAll('.bgr-bubble')]) {
        if (!seen.has(bubble.dataset.key)) bubble.remove();
    }

    const unread = entries.reduce((sum, e) => sum + e.finished, 0);
    const base = document.title.replace(TITLE_RE, '');
    const next = unread > 0 && settings.titleBadge !== false ? `(${unread}) ${base}` : base;
    if (document.title !== next) document.title = next;
    position();
}

let audioContext = null;
export function playDing() {
    try {
        audioContext ??= new (window.AudioContext || window['webkitAudioContext'])();
        const ctx = audioContext;
        if (ctx.state === 'suspended') ctx.resume();
        const now = ctx.currentTime;
        const tones = [[880, 0], [1320, 0.11]];
        for (const [freq, offset] of tones) {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0.0001, now + offset);
            gain.gain.exponentialRampToValueAtTime(0.18, now + offset + 0.015);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.28);
            osc.connect(gain).connect(ctx.destination);
            osc.start(now + offset);
            osc.stop(now + offset + 0.3);
        }
    } catch { /* ignore */ }
}

export function browserNotify(job, text) {
    try {
        if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
        const meta = job.meta;
        const title = meta.chat.kind === 'group' ? `${meta.chatName} · ${meta.speaker?.name ?? ''}` : (meta.speaker?.name ?? meta.chatName);
        const note = new Notification(title, {
            body: text || '새 답장이 도착했어요',
            icon: avatarUrl(job),
            tag: `bgr-${chatKeyString(meta.chat)}`,
        });
        note.onclick = () => {
            window.focus();
            onOpen(meta.chat);
            note.close();
        };
    } catch { /* ignore */ }
}

export function escapeForHtml(text) {
    return escapeHtml(text);
}
