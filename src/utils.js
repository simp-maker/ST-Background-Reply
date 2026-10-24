// Small shared helpers.

export const EXT_NAME = 'ST-Background-Reply';
export const SETTINGS_KEY = 'bgReply';
export const PLUGIN_ID = 'st-bg-reply';
export const PLUGIN_BASE = `/api/plugins/${PLUGIN_ID}`;
export const PLUGIN_PROTOCOL = 1;
export const PLUGIN_VERSION_BUNDLED = '1.0.0';
export const MARK = 'bg_reply';
export const LOG_PREFIX = '[BgReply]';

/** Generation endpoints we know how to run in the background. */
export const GEN_URLS = new Map([
    ['/api/backends/chat-completions/generate', 'openai'],
    ['/api/backends/text-completions/generate', 'textgenerationwebui'],
]);

export const SUPPORTED_TYPES = new Set(['normal', 'regenerate', 'swipe', 'continue']);
export const FINISHED = new Set(['done', 'error', 'aborted', 'interrupted']);

// The fetch that was in place when this extension loaded (other extensions may have wrapped it before us).
export const baseFetch = window.fetch.bind(window);

export function log(...args) {
    console.log(LOG_PREFIX, ...args);
}

export function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
}

export function uid() {
    const rnd = crypto.getRandomValues(new Uint32Array(2));
    return `bgr${Date.now().toString(36)}${rnd[0].toString(36)}${rnd[1].toString(36)}`.slice(0, 40);
}

/** Per-tab id that survives a reload of the same tab. */
export const TAB_ID = (() => {
    try {
        let id = sessionStorage.getItem('bgr_tab_id');
        if (!id) {
            id = uid();
            sessionStorage.setItem('bgr_tab_id', id);
        }
        return id;
    } catch {
        return uid();
    }
})();

/** cyrb53 string hash -> base36 */
export function hash(str, seed = 0) {
    str = String(str ?? '');
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + '.' + str.length.toString(36);
}

export function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitFor(condition, timeout = 15000, step = 50) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            if (condition()) return true;
        } catch { /* ignore */ }
        await delay(step);
    }
    return false;
}

export function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function plainPreview(text, max = 90) {
    const plain = String(text ?? '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/[*_`~#>]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return plain.length > max ? plain.slice(0, max - 1) + '…' : plain;
}

export function abortError() {
    return new DOMException('The user aborted a request.', 'AbortError');
}
