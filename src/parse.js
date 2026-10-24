// Turns the raw response bytes of a generation request (SSE stream or JSON) into text,
// using SillyTavern's own extractors so every API source is handled the same way as ST does.

import { extractMessageFromData } from '../../../../../script.js';
import { getStreamingReply } from '../../../../openai.js';
import { extractReasoningFromData } from '../../../../reasoning.js';

/**
 * Splits an SSE stream into the data payloads of complete events
 * (same rules as ST's EventSourceStream; an unterminated trailing event is ignored, like ST does).
 * @param {string} raw
 * @param {boolean} final Include an unterminated trailing event (used for live previews only).
 * @returns {string[]}
 */
export function splitSse(raw, final = false) {
    const parts = String(raw ?? '').split(/\r\n\r\n|\r\r|\n\n/g);
    const rest = parts.pop();
    if (final && rest && rest.trim()) parts.push(rest);
    const out = [];
    for (const chunk of parts) {
        let data = '';
        for (const line of chunk.split(/\n|\r|\r\n/g)) {
            const match = /([^:]+)(?:: ?(.*))?/.exec(line);
            if (match && match[1] === 'data') {
                data += (match[2] || '') + '\n';
            }
        }
        if (data === '') continue;
        out.push(data.endsWith('\n') ? data.slice(0, -1) : data);
    }
    return out;
}

function errorText(obj) {
    const err = obj?.error;
    if (!err) return null;
    if (typeof err === 'string') return err;
    return err.message || err.msg || JSON.stringify(err).slice(0, 500);
}

function hasToolCall(parsed) {
    return !!(
        parsed?.choices?.[0]?.delta?.tool_calls?.length ||
        parsed?.choices?.[0]?.message?.tool_calls?.length ||
        parsed?.content_block?.type === 'tool_use' ||
        parsed?.candidates?.[0]?.content?.parts?.some?.(p => p?.functionCall)
    );
}

/**
 * @param {object} meta Job meta (api, stream, source)
 * @param {string} raw Raw response text
 * @param {{ partial?: boolean }} [options] partial = the response is still being received
 * @returns {{ text: string, reasoning: string, error: string|null, tools: boolean }}
 */
export function parseRaw(meta, raw, { partial = false } = {}) {
    const result = { text: '', reasoning: '', error: null, tools: false };
    if (!raw) return result;

    if (meta.stream) {
        const events = splitSse(raw, partial);
        if (meta.api === 'openai') {
            const state = { reasoning: '', images: [], signature: '', toolSignatures: {} };
            for (const data of events) {
                if (data === '[DONE]') break;
                let parsed;
                try { parsed = JSON.parse(data); } catch { continue; }
                const err = errorText(parsed);
                if (err) {
                    result.error = err;
                    continue;
                }
                if (Array.isArray(parsed?.choices) && parsed.choices[0]?.index > 0) continue; // extra swipes (n > 1)
                if (hasToolCall(parsed)) result.tools = true;
                try {
                    result.text += getStreamingReply(parsed, state, { chatCompletionSource: meta.source }) || '';
                } catch (error) {
                    console.debug('[BgReply] getStreamingReply failed', error);
                }
            }
            result.reasoning = state.reasoning || '';
        } else {
            let reasoning = '';
            for (const data of events) {
                if (data === '[DONE]') break;
                let parsed;
                try { parsed = JSON.parse(data); } catch { continue; }
                const err = errorText(parsed);
                if (err) {
                    result.error = err;
                    continue;
                }
                if (parsed?.choices?.[0]?.index > 0 || parsed?.index > 0) continue;
                result.text += parsed?.choices?.[0]?.text || parsed?.content || '';
                reasoning += parsed?.choices?.[0]?.reasoning ?? parsed?.choices?.[0]?.thinking ?? '';
            }
            result.reasoning = reasoning;
        }
        return result;
    }

    // Non-streaming: a single JSON document
    if (partial) return result;
    let data;
    try {
        data = JSON.parse(raw);
    } catch {
        result.error = 'The API returned a response that could not be read.';
        return result;
    }
    const err = errorText(data);
    if (err) result.error = err;
    if (hasToolCall(data)) result.tools = true;
    try {
        result.text = extractMessageFromData(data, meta.api) || '';
    } catch { /* ignore */ }
    try {
        result.reasoning = extractReasoningFromData(data, {
            mainApi: meta.api,
            chatCompletionSource: meta.api === 'openai' ? meta.source : null,
            textGenType: meta.api === 'textgenerationwebui' ? meta.source : null,
        }) || '';
    } catch { /* ignore */ }
    return result;
}
