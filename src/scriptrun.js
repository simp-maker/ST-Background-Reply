// Lets a slash command script that is waiting for a background /gen stop blocking the chat input.
//
// When a script is run from the chat input (typed command or a Quick Reply button), SillyTavern
// keeps a lock ("isExecutingCommandsFromChatInput") until the whole script has finished. While it
// is set, Enter / Send / QR buttons do nothing, so a /gen that waits in the background would keep the
// input dead until its reply arrives and the rest of the script has run.
//
// We wrap SlashCommandClosure.prototype.execute for the root closure of chat-input runs: normally it
// just returns the real result, but `releaseRun()` makes SillyTavern see the run as finished right
// away (lock, progress bar and pause/stop buttons go back to normal) while the real execution keeps
// going. Whatever happens to it afterwards (result, errors, abort) is reported here, like
// SillyTavern would have done.

import * as slash from '../../../../slash-commands.js';
import { SlashCommandClosure } from '../../../../slash-commands/SlashCommandClosure.js';
import { SlashCommandClosureResult } from '../../../../slash-commands/SlashCommandClosureResult.js';
import { SlashCommandExecutionError } from '../../../../slash-commands/SlashCommandExecutionError.js';
import { log, warn } from './utils.js';

/** abort controller of a chat-input run -> run info */
const runs = new WeakMap();
/** runs released from the chat input that are still going */
const released = new Set();

export function initScriptRuns() {
    const proto = SlashCommandClosure?.prototype;
    if (!proto || typeof proto.execute !== 'function' || proto.execute.__bgrRun) return;
    const original = proto.execute;
    const patched = function (...args) {
        const ctrl = this.abortController;
        let fromChatInput = false;
        try { fromChatInput = !!ctrl && ctrl === slash.commandsFromChatInputAbortController; } catch { /* ignore */ }
        // Only the outermost closure of a chat-input run (nested closures share its controller).
        if (!fromChatInput || runs.has(ctrl)) return original.apply(this, args);

        const run = { ctrl, released: false, release: null, startedAt: Date.now() };
        runs.set(ctrl, run);
        const progress = this.onProgress;
        if (typeof progress === 'function') {
            // the progress bar belongs to the chat input again once the run is released
            this.onProgress = (done, total) => { if (!run.released) progress(done, total); };
        }
        const releasedPromise = new Promise(resolve => { run.release = resolve; });
        const real = Promise.resolve().then(() => original.apply(this, args));
        real.then(result => settled(run, result, null), error => settled(run, null, error));
        return Promise.race([real, releasedPromise]);
    };
    patched.__bgrRun = true;
    proto.execute = patched;
}

function settled(run, result, error) {
    runs.delete(run.ctrl);
    if (!run.released) return; // SillyTavern itself got the result
    released.delete(run);
    if (error) {
        reportError(error);
        return;
    }
    if (result?.isAborted && !result.isQuietlyAborted) {
        toastr.warning(String(result.abortReason ?? ''), 'Command execution aborted');
    }
    log('released script finished', Math.round((Date.now() - run.startedAt) / 1000) + 's');
}

function reportError(error) {
    if (error?.cause === 'abort') return;
    if (error instanceof SlashCommandExecutionError) {
        const div = document.createElement('div');
        const escape = (text) => { div.textContent = String(text ?? ''); return div.innerHTML; };
        toastr.error(
            `<div>${escape(error.message)}</div><div>Line: ${error.line} Column: ${error.column}</div><pre style="text-align:left;">${escape(error.hint)}</pre>`,
            'Slash Command Execution Error',
            { escapeHtml: false, timeOut: 10000 },
        );
    } else {
        toastr.error(error?.message || String(error));
    }
    warn('released script failed', error);
}

/**
 * Makes the chat-input run owning `ctrl` look finished to SillyTavern (its remaining commands keep
 * running in the background).
 * @returns {boolean} released now
 */
export function releaseRun(ctrl) {
    const run = ctrl ? runs.get(ctrl) : null;
    if (!run || run.released) return false;
    run.released = true;
    released.add(run);
    const result = new SlashCommandClosureResult();
    result.pipe = '';
    run.release(result);
    log('chat input released, the rest of the script continues in the background');
    return true;
}

/** Is `ctrl` the controller of the chat-input run that is still locking the input? */
export function isLockingRun(ctrl) {
    const run = ctrl ? runs.get(ctrl) : null;
    return !!run && !run.released;
}

/** Was `ctrl` released from the chat input (its script now runs in the background)? */
export function isReleasedRun(ctrl) {
    const run = ctrl ? runs.get(ctrl) : null;
    return !!run && run.released;
}

/** Number of released scripts still running (for the panel/debugging). */
export function releasedCount() {
    return released.size;
}
