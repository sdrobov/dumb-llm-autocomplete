import type * as vscode from 'vscode';

import type { Config } from './config';
import type { PreparedPrompt } from './prompt';

// ponytail: FIM/chat models wrap the answer in ```fence```. The opening fence
// appears FIRST, before any real content — stopping on it drops the whole answer.
// Track whether we've yielded anything meaningful; only stop on a fence AFTER that.
const STOP_TOKENS = ['```'];

export type ApiStyle = 'openai-compatible' | 'ollama-native';

/**
 * Streaming chat completion. Yields filtered text chunks from the model.
 *
 * ponytail: don't abort on cancellation. The token might be cancelled by VSCode
 * for reasons that have nothing to do with our model request (e.g. user types
 * another char), and aborting fetch() also kills the body read mid-stream —
 * `Response.body.getReader()` is bound to the AbortSignal even after the
 * response headers arrive. So we let the request run to completion (or to our
 * own timeout) and let the caller decide whether to use the result.
 *
 * The caller compares its call-id to the provider's latest call-id at the end
 * and drops the result if a newer call has superseded.
 */
export async function* streamCompletion(
    cfg: Config,
    apiKey: string | undefined,
    prepared: PreparedPrompt,
    _token: vscode.CancellationToken,
): AsyncGenerator<string> {
    if (cfg.apiStyle === 'ollama-native') {
        yield* streamOllamaNative(cfg, apiKey, prepared);
        return;
    }
    yield* streamChat(cfg, apiKey, prepared);
}

async function* streamChat(
    cfg: Config,
    apiKey: string | undefined,
    prepared: PreparedPrompt,
): AsyncGenerator<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

        const url = endpointFor(cfg.apiEndpoint, cfg.apiStyle);
        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: cfg.model,
                messages: [
                    { role: 'system', content: prepared.systemPrompt },
                    { role: 'user', content: prepared.userPrompt },
                ],
                max_tokens: prepared.maxTokens,
                temperature: cfg.temperature,
                stream: true,
                ...(prepared.stop.length > 0 ? { stop: prepared.stop } : {}),
            }),
            signal: controller.signal,
        });

        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
        }
        if (!res.body) throw new Error('Malformed SSE response: no body');

        const raw = parseSse(res.body);
        const filtered = applyFilters(raw);
        for await (const chunk of filtered) {
            yield chunk;
        }
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Ollama's native /api/generate endpoint. Pass `prompt` and `suffix` as
 * separate fields — Ollama applies the model's FIM template
 * (e.g. qwen2.5-coder uses `<|fim_prefix|>...<|fim_suffix|>...<|fim_middle|>`)
 * automatically. No need to construct FIM tokens in the prompt ourselves.
 *
 * The OpenAI-compatible /v1/chat/completions endpoint does NOT do this — it
 * ignores FIM markers and the model responds as a chat assistant.
 *
 * Stream format: JSON Lines, one object per line:
 *   {"model":"...","response":"token","done":false}
 *   {"model":"...","response":"","done":true,"done_reason":"stop"}
 */
async function* streamOllamaNative(
    cfg: Config,
    _apiKey: string | undefined,
    prepared: PreparedPrompt,
): AsyncGenerator<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
        const url = endpointFor(cfg.apiEndpoint, cfg.apiStyle);

        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: cfg.model,
                prompt: prepared.prunedPrefix,
                suffix: prepared.prunedSuffix,
                stream: true,
                options: {
                    temperature: cfg.temperature,
                    num_predict: prepared.maxTokens,
                    stop: prepared.stop,
                },
            }),
            signal: controller.signal,
        });

        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
        }
        if (!res.body) throw new Error('Malformed Ollama response: no body');

        const raw = parseOllamaJsonl(res.body);
        const filtered = applyFilters(raw);
        for await (const chunk of filtered) {
            yield chunk;
        }
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Derive the request URL from `apiEndpoint` (which the user types as a base URL)
 * and the chosen `apiStyle`. Accepts both bare bases and legacy full paths so
 * existing configs keep working.
 *
 *   apiStyle="chat"          → ${base}/v1/chat/completions
 *   apiStyle="ollama-native" → ${base}/api/generate
 *
 *   http://localhost:11434              → http://localhost:11434/v1/chat/completions
 *   http://localhost:11434/v1/chat/...  → http://localhost:11434/v1/chat/completions (no-op)
 *   https://api.openai.com              → https://api.openai.com/v1/chat/completions
 *   https://api.openai.com/v1           → https://api.openai.com/v1/chat/completions
 */
export function endpointFor(apiEndpoint: string, apiStyle: ApiStyle): string {
    const base = stripTrailingPath(apiEndpoint);
    if (apiStyle === 'ollama-native') return `${base}/api/generate`;
    return `${base}/v1/chat/completions`;
}

function stripTrailingPath(url: string): string {
    // Strip a known full path so the caller can re-append the one it wants.
    url = url.replace(/\/v1\/chat\/completions\/?$/, '');
    url = url.replace(/\/api\/generate\/?$/, '');
    url = url.replace(/\/api\/chat\/?$/, '');
    url = url.replace(/\/v1\/?$/, ''); // bare `/v1` is common (OpenAI)
    return url.replace(/\/+$/, '') || 'http://localhost:11434';
}

/* ---------- SSE (OpenAI chat completions) ---------- */

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf('\n')) !== -1) {
                const line = buf.slice(0, nl).replace(/\r$/, '');
                buf = buf.slice(nl + 1);
                if (line.startsWith('data:')) {
                    const payload = line.slice(5).trim();
                    if (payload === '[DONE]') return;
                    if (payload.length === 0) continue;
                    let json: any;
                    try {
                        json = JSON.parse(payload);
                    } catch {
                        continue;
                    }
                    const delta = json?.choices?.[0]?.delta?.content;
                    if (typeof delta === 'string' && delta.length > 0) yield delta;
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
}

/* ---------- JSON Lines (Ollama native) ---------- */

async function* parseOllamaJsonl(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf('\n')) !== -1) {
                const line = buf.slice(0, nl).replace(/\r$/, '');
                buf = buf.slice(nl + 1);
                if (line.length === 0) continue;
                let json: any;
                try {
                    json = JSON.parse(line);
                } catch {
                    continue;
                }
                if (json.done) return;
                const token = json.response;
                if (typeof token === 'string' && token.length > 0) yield token;
            }
        }
    } finally {
        reader.releaseLock();
    }
}

/* ---------- filter pipeline (shared) ---------- */

function applyFilters(input: AsyncIterable<string>): AsyncGenerator<string> {
    let s = stopOnStopToken(input, STOP_TOKENS);
    let lines$ = splitLines(s);
    lines$ = stopAtRepeatingLines(lines$);
    lines$ = noDoubleNewLine(lines$);
    return joinLines(lines$);
}

async function* stopOnStopToken(
    input: AsyncIterable<string>,
    tokens: string[],
): AsyncGenerator<string> {
    const maxLen = Math.max(...tokens.map((t) => t.length));
    let buf = '';
    let start = 0;
    let yielded = 0;

    interface StopHit { idx: number; tok: string; }
    const firstStop = (from: number): StopHit | undefined => {
        let best: StopHit | undefined;
        for (const tok of tokens) {
            const idx = buf.indexOf(tok, from);
            if (idx !== -1 && (best === undefined || idx < best.idx)) {
                best = { idx, tok };
            }
        }
        return best;
    };

    const skipOpeningFence = (): boolean => {
        const hit = firstStop(start);
        if (!hit) return false;
        const between = buf.slice(start, hit.idx);
        if (between.trim().length > 0) return false;
        start = hit.idx + hit.tok.length;
        const lang = buf.slice(start).match(/^[a-zA-Z0-9_-]*\n?/);
        if (lang) start += lang[0].length;
        return true;
    };

    for await (const chunk of input) {
        buf += chunk;
        const safe = buf.length - maxLen;
        if (safe <= start) continue;
        if (yielded > 0) {
            const hit = firstStop(start);
            if (hit && hit.idx < safe) {
                const between = buf.slice(start, hit.idx);
                if (between.trim().length > 0) { yield between; return; }
                start = hit.idx + hit.tok.length;
                const lang = buf.slice(start).match(/^[a-zA-Z0-9_-]*\n?/);
                if (lang) start += lang[0].length;
            }
        }
        if (safe > start) {
            const out = buf.slice(start, safe);
            yielded += out.length;
            yield out;
            start = safe;
        }
    }
    while (skipOpeningFence()) { /* keep skipping */ }
    const hit = firstStop(start);
    if (hit) {
        const between = buf.slice(start, hit.idx);
        if (between.trim().length > 0) { yield between; return; }
        start = hit.idx + hit.tok.length;
        const lang = buf.slice(start).match(/^[a-zA-Z0-9_-]*\n?/);
        if (lang) start += lang[0].length;
    }
    if (start < buf.length) yield buf.slice(start);
}

async function* splitLines(input: AsyncIterable<string>): AsyncGenerator<string> {
    let buf = '';
    for await (const chunk of input) {
        buf += chunk;
        const parts = buf.split('\n');
        buf = parts.pop() ?? '';
        for (const p of parts) yield p;
    }
    if (buf.length > 0) yield buf;
}

async function* stopAtRepeatingLines(
    input: AsyncIterable<string>,
): AsyncGenerator<string> {
    let prev: string | undefined;
    let count = 0;
    for await (const line of input) {
        if (line === prev) {
            count++;
            if (count === 3) return;
        } else {
            count = 1;
            yield line;
        }
        prev = line;
    }
}

async function* noDoubleNewLine(
    input: AsyncIterable<string>,
): AsyncGenerator<string> {
    let prevWasBlank = false;
    let isFirst = true;
    for await (const line of input) {
        if (!isFirst && line.trim() === '' && prevWasBlank) return;
        yield line;
        prevWasBlank = line.trim() === '';
        isFirst = false;
    }
}

async function* joinLines(input: AsyncIterable<string>): AsyncGenerator<string> {
    let first = true;
    for await (const line of input) {
        if (!first) yield '\n';
        first = false;
        yield line;
    }
}
