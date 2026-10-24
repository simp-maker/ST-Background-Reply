// ST-Background-Reply — keep replies generating while you leave the chat, reload, or close the tab.
// See README.md for how it works and how to install the optional server plugin.

import { saveSettingsDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { SETTINGS_KEY, log } from './src/utils.js';
import { detectBackend } from './src/backend.js';
import { initCapture } from './src/capture.js';
import { initController, applyBusy, applyIdle, isNotifiable, onReleased, openFromDock, dismiss } from './src/controller.js';
import { initNav } from './src/nav.js';
import { initNotify, render as renderDock } from './src/notify.js';
import { initPanel } from './src/panel.js';
import { initPipeline } from './src/pipeline.js';
import { initScriptRuns } from './src/scriptrun.js';

const DEFAULTS = Object.freeze({
    enabled: true,
    genBackground: true,
    genFreeInput: true,
    livePreview: true,
    showRunning: true,
    sound: true,
    titleBadge: true,
    browserNotify: false,
    position: 'right',
    showDock: true,
});

function settings() {
    extension_settings[SETTINGS_KEY] ??= {};
    const current = extension_settings[SETTINGS_KEY];
    for (const [key, value] of Object.entries(DEFAULTS)) {
        if (current[key] === undefined) current[key] = value;
    }
    return current;
}

// Wrap fetch right away so the very first generation after page load is covered too.
let resolveReady;
const ready = new Promise(resolve => { resolveReady = resolve; });
initCapture({ settings, ready, released: (job) => onReleased(job) });
initPipeline({ freeInput: () => settings().genFreeInput !== false });
try {
    initScriptRuns();
} catch (error) {
    console.warn('[BgReply] could not hook slash command runs', error);
}

jQuery(async () => {
    settings();
    initNav({ settings, applyBusy, applyIdle });
    initNotify({ settings, notifiable: isNotifiable, open: openFromDock, dismiss });
    try {
        await detectBackend();
    } finally {
        resolveReady();
    }
    initController({ settings });
    initPanel({ settings, save: saveSettingsDebounced });
    renderDock();
    log('ready');
});
