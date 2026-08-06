import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseSse, parseOllamaJsonl, streamChat, streamOllamaNative, streamCompletion } from '../../src/streaming';
import type { Config } from '../../src/config';
import type { PreparedPrompt } from '../../src/prompt';

/* ---------- helpers ---------- */

function makeBody(chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (const c of chunks) controller.enqueue(enc.encode(c));
            controller.close();
        },
    });
}

async function collect<T>(g: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const x of g) out.push(x);
    return out;
}

function baseCfg(overrides: Partial<Config> = {}): Config {
    return {
        enabled: true,
        apiEndpoint: 'http://localhost:11434',
        model: 'qwen2.5-coder',
        maxTokens: 128,
        temperature: 0.2,
        debounceMs: 750,
        contextLines: 50,
        timeoutMs: 15000,
        maxPromptTokens: 2048,
        multiline: 'auto',
        systemPrompt: 'system',
        useCache: true,
        debug: false,
        apiStyle: 'openai-compatible',
        ...overrides,
    };
}

function basePrepared(overrides: Partial<PreparedPrompt> = {}): PreparedPrompt {
    return {
        systemPrompt: 'system',
        userPrompt: 'user',
        prunedPrefix: 'prefix',
        prunedSuffix: 'suffix',
        multiline: false,
        maxTokens: 128,
        stop: ['```'],
        ...overrides,
    };
}

const token: any = { isCancellationRequested: false, onCancellationRequested: vi.fn() };

/* ---------- parseSse ---------- */

describe('parseSse', () => {
    it('parses a single SSE chunk with delta content', async () => {
        const body = makeBody([
            'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
        ]);
        const out = await collect(parseSse(body));
        expect(out).toEqual(['hello']);
    });

    it('parses multiple chunks into individual deltas', async () => {
        const body = makeBody([
            'data: {"choices":[{"delta":{"content":"foo"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"bar"}}]}\n\n',
        ]);
        const out = await collect(parseSse(body));
        expect(out).toEqual(['foo', 'bar']);
    });

    it('stops on [DONE]', async () => {
        const body = makeBody([
            'data: {"choices":[{"delta":{"content":"foo"}}]}\n\n',
            'data: [DONE]\n\n',
            'data: {"choices":[{"delta":{"content":"after"}}]}\n\n',
        ]);
        const out = await collect(parseSse(body));
        expect(out).toEqual(['foo']);
    });

    it('skips lines that are not "data:"', async () => {
        const body = makeBody([
            'event: message\n',
            'data: {"choices":[{"delta":{"content":"foo"}}]}\n\n',
        ]);
        const out = await collect(parseSse(body));
        expect(out).toEqual(['foo']);
    });

    it('skips malformed JSON without throwing', async () => {
        const body = makeBody([
            'data: not-json\n\n',
            'data: {"choices":[{"delta":{"content":"foo"}}]}\n\n',
        ]);
        const out = await collect(parseSse(body));
        expect(out).toEqual(['foo']);
    });

    it('skips empty data payloads', async () => {
        const body = makeBody([
            'data: \n\n',
            'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
        ]);
        const out = await collect(parseSse(body));
        expect(out).toEqual(['x']);
    });

    it('skips chunks where delta is empty', async () => {
        const body = makeBody([
            'data: {"choices":[{"delta":{"content":""}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"foo"}}]}\n\n',
        ]);
        const out = await collect(parseSse(body));
        expect(out).toEqual(['foo']);
    });

    it('handles \\r\\n line endings', async () => {
        const body = makeBody([
            'data: {"choices":[{"delta":{"content":"foo"}}]}\r\n\r\n',
        ]);
        const out = await collect(parseSse(body));
        expect(out).toEqual(['foo']);
    });

    it('handles multiple JSON objects on a single line of input (chunked across reads)', async () => {
        const body = makeBody([
            'data: {"choices":[{"delta":{"content":"a"}}]}\n',
            'data: {"choices":[{"delta":{"content":"b"}}]}\n',
        ]);
        const out = await collect(parseSse(body));
        expect(out).toEqual(['a', 'b']);
    });

    it('handles a delta that is not a string', async () => {
        const body = makeBody([
            'data: {"choices":[{"delta":{"content":42}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"foo"}}]}\n\n',
        ]);
        const out = await collect(parseSse(body));
        expect(out).toEqual(['foo']);
    });
});

/* ---------- parseOllamaJsonl ---------- */

describe('parseOllamaJsonl', () => {
    it('parses a single token line', async () => {
        const body = makeBody([
            JSON.stringify({ model: 'q', response: 'hello', done: false }) + '\n',
        ]);
        const out = await collect(parseOllamaJsonl(body));
        expect(out).toEqual(['hello']);
    });

    it('stops on done:true', async () => {
        const body = makeBody([
            JSON.stringify({ response: 'foo', done: false }) + '\n',
            JSON.stringify({ response: '', done: true, done_reason: 'stop' }) + '\n',
            JSON.stringify({ response: 'after', done: false }) + '\n',
        ]);
        const out = await collect(parseOllamaJsonl(body));
        expect(out).toEqual(['foo']);
    });

    it('skips malformed JSON lines', async () => {
        const body = makeBody([
            'not-json\n',
            JSON.stringify({ response: 'foo', done: false }) + '\n',
        ]);
        const out = await collect(parseOllamaJsonl(body));
        expect(out).toEqual(['foo']);
    });

    it('skips empty lines', async () => {
        const body = makeBody([
            '\n',
            JSON.stringify({ response: 'foo', done: false }) + '\n',
        ]);
        const out = await collect(parseOllamaJsonl(body));
        expect(out).toEqual(['foo']);
    });

    it('skips empty response strings', async () => {
        const body = makeBody([
            JSON.stringify({ response: '', done: false }) + '\n',
            JSON.stringify({ response: 'foo', done: false }) + '\n',
        ]);
        const out = await collect(parseOllamaJsonl(body));
        expect(out).toEqual(['foo']);
    });

    it('handles non-string response (skips it)', async () => {
        const body = makeBody([
            JSON.stringify({ response: 42, done: false }) + '\n',
            JSON.stringify({ response: 'foo', done: false }) + '\n',
        ]);
        const out = await collect(parseOllamaJsonl(body));
        expect(out).toEqual(['foo']);
    });
});

/* ---------- streamChat (with mocked fetch) ---------- */

describe('streamChat', () => {
    let originalFetch: typeof fetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('streams chat completions and yields filtered tokens', async () => {
        globalThis.fetch = vi.fn(async () => {
            const enc = new TextEncoder();
            return new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"retu"}}]}\n\n'));
                        controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"rn 42"}}]}\n\n'));
                        controller.enqueue(enc.encode('data: [DONE]\n\n'));
                        controller.close();
                    },
                }),
                { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
            );
        }) as any;

        const out = await collect(streamChat(baseCfg(), 'k', basePrepared()));
        // No fence to stop on — everything flows through filters and gets
        // joined back as a single string with one space split across chunks.
        const text = out.join('');
        expect(text).toContain('return 42');
    });

    it('sends Authorization header when apiKey is provided', async () => {
        const fetchMock = vi.fn<typeof fetch>(async () => new Response('data: [DONE]\n\n', { status: 200 }));
        globalThis.fetch = fetchMock;

        for await (const _ of streamChat(baseCfg(), 'secret-key', basePrepared())) {
            // noop
        }
        const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
        const headers = init?.headers as Record<string, string> | undefined;
        expect(headers?.['Authorization']).toBe('Bearer secret-key');
    });

    it('omits Authorization header when no apiKey', async () => {
        const fetchMock = vi.fn<typeof fetch>(async () => new Response('', { status: 200 }));
        globalThis.fetch = fetchMock;

        for await (const _ of streamChat(baseCfg(), undefined, basePrepared())) {
            // noop
        }
        const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
        const headers = init?.headers as Record<string, string> | undefined;
        expect(headers?.['Authorization']).toBeUndefined();
    });

    it('throws on HTTP error with body excerpt', async () => {
        globalThis.fetch = vi.fn(async () => new Response('bad request', { status: 400, statusText: 'Bad Request' })) as any;

        await expect(async () => {
            for await (const _ of streamChat(baseCfg(), 'k', basePrepared())) {
                // noop
            }
        }).rejects.toThrow(/HTTP 400/);
    });

    it('throws on missing response body', async () => {
        globalThis.fetch = vi.fn(async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            body: null,
        })) as any;

        await expect(async () => {
            for await (const _ of streamChat(baseCfg(), 'k', basePrepared())) {
                // noop
            }
        }).rejects.toThrow(/no body/);
    });

    it('includes stop tokens in request body when non-empty', async () => {
        const fetchMock = vi.fn<typeof fetch>(async () => new Response('', { status: 200 }));
        globalThis.fetch = fetchMock;

        for await (const _ of streamChat(baseCfg(), 'k', basePrepared({ stop: ['<|fim_prefix|>', '\n'] }))) {
            // noop
        }
        const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
        const body = JSON.parse(init?.body as string);
        expect(body.stop).toEqual(['<|fim_prefix|>', '\n']);
    });

    it('omits stop from body when empty', async () => {
        const fetchMock = vi.fn<typeof fetch>(async () => new Response('', { status: 200 }));
        globalThis.fetch = fetchMock;

        for await (const _ of streamChat(baseCfg(), 'k', basePrepared({ stop: [] }))) {
            // noop
        }
        const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
        const body = JSON.parse(init?.body as string);
        expect(body.stop).toBeUndefined();
    });

    it('sends the right URL based on apiEndpoint and apiStyle', async () => {
        const fetchMock = vi.fn<typeof fetch>(async () => new Response('', { status: 200 }));
        globalThis.fetch = fetchMock;

        for await (const _ of streamChat(
            baseCfg({ apiEndpoint: 'http://localhost:1234', apiStyle: 'openai-compatible' }),
            'k',
            basePrepared(),
        )) {
            // noop
        }
        expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:1234/v1/chat/completions');
    });
});

/* ---------- streamOllamaNative (with mocked fetch) ---------- */

describe('streamOllamaNative', () => {
    let originalFetch: typeof fetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('streams Ollama JSONL responses', async () => {
        const enc = new TextEncoder();
        globalThis.fetch = vi.fn(async () => new Response(
            new ReadableStream({
                start(controller) {
                    controller.enqueue(enc.encode(JSON.stringify({ response: 'foo', done: false }) + '\n'));
                    controller.enqueue(enc.encode(JSON.stringify({ response: 'bar', done: false }) + '\n'));
                    controller.enqueue(enc.encode(JSON.stringify({ response: '', done: true }) + '\n'));
                    controller.close();
                },
            }),
            { status: 200 },
        )) as any;

        const out = await collect(streamOllamaNative(
            baseCfg({ apiEndpoint: 'http://localhost:11434', apiStyle: 'ollama-native' }),
            'k',
            basePrepared(),
        ));
        expect(out.join('')).toContain('foobar');
    });

    it('sends prompt, suffix, and options.num_predict in the body', async () => {
        const fetchMock = vi.fn<typeof fetch>(async () => new Response('', { status: 200 }));
        globalThis.fetch = fetchMock;

        for await (const _ of streamOllamaNative(
            baseCfg({ apiEndpoint: 'http://localhost:11434', apiStyle: 'ollama-native' }),
            'k',
            basePrepared({ prunedPrefix: 'PRE', prunedSuffix: 'SUF', maxTokens: 99 }),
        )) {
            // noop
        }
        const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
        const body = JSON.parse(init?.body as string);
        expect(body.prompt).toBe('PRE');
        expect(body.suffix).toBe('SUF');
        expect(body.options.num_predict).toBe(99);
        expect(body.stream).toBe(true);
    });

    it('throws on HTTP error', async () => {
        globalThis.fetch = vi.fn(async () => new Response('nope', { status: 500, statusText: 'Server Error' })) as any;

        await expect(async () => {
            for await (const _ of streamOllamaNative(
                baseCfg({ apiStyle: 'ollama-native' }),
                'k',
                basePrepared(),
            )) {
                // noop
            }
        }).rejects.toThrow(/HTTP 500/);
    });

    it('throws on missing body', async () => {
        globalThis.fetch = vi.fn(async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            body: null,
        })) as any;

        await expect(async () => {
            for await (const _ of streamOllamaNative(
                baseCfg({ apiStyle: 'ollama-native' }),
                'k',
                basePrepared(),
            )) {
                // noop
            }
        }).rejects.toThrow(/no body/);
    });
});

/* ---------- streamCompletion dispatch ---------- */

describe('streamCompletion', () => {
    let originalFetch: typeof fetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('dispatches to streamOllamaNative when apiStyle is ollama-native', async () => {
        const enc = new TextEncoder();
        globalThis.fetch = vi.fn(async () => new Response(
            new ReadableStream({
                start(controller) {
                    controller.enqueue(enc.encode(JSON.stringify({ response: 'x', done: false }) + '\n'));
                    controller.enqueue(enc.encode(JSON.stringify({ response: '', done: true }) + '\n'));
                    controller.close();
                },
            }),
            { status: 200 },
        )) as any;

        const out = await collect(streamCompletion(
            baseCfg({ apiStyle: 'ollama-native' }),
            'k',
            basePrepared(),
            token,
        ));
        expect(out.join('')).toBe('x');
    });

    it('dispatches to streamChat when apiStyle is openai-compatible', async () => {
        const enc = new TextEncoder();
        globalThis.fetch = vi.fn(async () => new Response(
            new ReadableStream({
                start(controller) {
                    controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'));
                    controller.enqueue(enc.encode('data: [DONE]\n\n'));
                    controller.close();
                },
            }),
            { status: 200 },
        )) as any;

        const out = await collect(streamCompletion(
            baseCfg({ apiStyle: 'openai-compatible' }),
            'k',
            basePrepared(),
            token,
        ));
        expect(out.join('')).toBe('x');
    });
});
