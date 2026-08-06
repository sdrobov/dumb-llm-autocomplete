import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Inline the vscode mock factory because vitest hoists vi.mock() factories
// to the top of the file — before any imports run. The factory body must be
// self-contained and cannot reference top-level variables.
vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => undefined,
        onDidChangeConfiguration: () => undefined,
    },
    window: {
        createOutputChannel: () => ({
            appendLine: () => undefined,
            show: () => undefined,
            clear: () => undefined,
            dispose: () => undefined,
        }),
        showInformationMessage: () => undefined,
        showWarningMessage: () => undefined,
        showErrorMessage: () => undefined,
        showInputBox: () => undefined,
        activeTextEditor: undefined,
    },
    languages: {
        registerInlineCompletionItemProvider: () => ({ dispose: () => undefined }),
    },
    commands: {
        registerCommand: () => ({ dispose: () => undefined }),
        executeCommand: () => undefined,
    },
    InlineCompletionTriggerKind: { Invoke: 0, Automatic: 1 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    EventEmitter: class { event = () => undefined; fire = () => undefined; dispose = () => undefined; },
    Uri: {
        file: (p: string) => ({ fsPath: p, toString: () => `file://${p}`, scheme: 'file' }),
        parse: (s: string) => ({ fsPath: s, toString: () => s, scheme: 'file' }),
    },
    Range: class { constructor(public start: { line: number; character: number }, public end: { line: number; character: number }) {} },
    Position: class { constructor(public line: number, public character: number) {} },
    InlineCompletionItem: class { constructor(public insertText: string, public range?: unknown, public command?: unknown) {} },
    CancellationTokenSource: class { token = { isCancellationRequested: false, onCancellationRequested: () => undefined }; cancel() {} dispose() {} },
    CancellationToken: class { isCancellationRequested = false; onCancellationRequested = () => undefined; },
    SecretStorage: class { store = () => undefined; get = () => undefined; delete = () => undefined; onDidChange = () => undefined; },
    Disposable: class { constructor(_?: unknown) {} dispose = () => undefined; },
}));

import * as vscode from 'vscode';
import * as cacheModule from '../../src/cache';
import type { LruCache } from '../../src/cache';
import * as streamingModule from '../../src/streaming';
import * as configModule from '../../src/config';
import * as postprocessModule from '../../src/postprocess';
import type { Config } from '../../src/config';
import { activate, deactivate } from '../../src/extension';

/* ---------- helpers ---------- */

function makeDocument(filePath: string, lines: string[], languageId = 'typescript'): vscode.TextDocument {
    return {
        languageId,
        lineCount: lines.length,
        lineAt: (line: number) => {
            const text = lines[line] ?? '';
            return {
                text,
                range: { start: { line, character: 0 }, end: { line, character: text.length } },
                rangeWithLineBreak: undefined as any,
                firstNonWhitespaceCharacterIndex: 0,
                isEmptyOrWhitespace: text.trim().length === 0,
            };
        },
        getText: (range?: any) => {
            if (!range) return lines.join('\n');
            const startLine = range.start.line;
            const startChar = range.start.character;
            const endLine = range.end.line;
            const endChar = range.end.character;
            if (startLine === endLine) {
                return (lines[startLine] ?? '').slice(startChar, endChar);
            }
            const parts: string[] = [];
            parts.push((lines[startLine] ?? '').slice(startChar));
            for (let i = startLine + 1; i < endLine; i++) parts.push(lines[i] ?? '');
            parts.push((lines[endLine] ?? '').slice(0, endChar));
            return parts.join('\n');
        },
        uri: { fsPath: filePath, toString: () => `file://${filePath}`, scheme: 'file' },
        fileName: filePath,
    } as any;
}

function makePosition(line: number, character: number): vscode.Position {
    return new vscode.Position(line, character);
}

function makeContext(overrides: Partial<vscode.InlineCompletionContext> = {}): vscode.InlineCompletionContext {
    return {
        triggerKind: vscode.InlineCompletionTriggerKind.Invoke,
        selectedCompletionInfo: undefined,
        ...overrides,
    } as any;
}

function baseCfg(overrides: Partial<Config> = {}): Config {
    return {
        enabled: true,
        apiEndpoint: 'http://localhost:11434',
        model: 'gpt-4',
        maxTokens: 256,
        temperature: 0.2,
        debounceMs: 50,
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

function makeToken(): vscode.CancellationToken {
    // CancellationToken is an interface in @types/vscode — build a minimal one.
    return {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => undefined }),
    } as vscode.CancellationToken;
}

/**
 * Provider results can be an array, a list, or null — tests work with arrays.
 * Narrowing via Array.isArray instead of a cast.
 */
function itemsOf(
    out: vscode.ProviderResult<vscode.InlineCompletionItem[] | vscode.InlineCompletionList>,
): vscode.InlineCompletionItem[] {
    if (out === null || out === undefined) return [];
    if ('then' in out) return [];
    return Array.isArray(out) ? out : out.items;
}

/** LruCache has private members; tests only exercise the public surface. */
function mockCache(overrides: Partial<Pick<LruCache, 'get' | 'put' | 'close'>> = {}): LruCache {
    return {
        get: overrides.get ?? vi.fn(),
        put: overrides.put ?? vi.fn(),
        close: overrides.close ?? vi.fn(),
    } as unknown as LruCache;
}

/* ---------- mock factories ---------- */

let registerProviderMock: ReturnType<typeof vi.fn>;
let registerCommandMock: ReturnType<typeof vi.fn>;
let showInputBoxMock: ReturnType<typeof vi.fn>;
let getConfigMock: ReturnType<typeof vi.fn>;
let secretsStoreMock: ReturnType<typeof vi.fn>;
let secretsGetMock: ReturnType<typeof vi.fn>;
let secretsDeleteMock: ReturnType<typeof vi.fn>;
let executeCommandMock: ReturnType<typeof vi.fn>;

let context: vscode.ExtensionContext;
let provider: vscode.InlineCompletionItemProvider;

beforeEach(() => {
    // Wire up the vscode mocks to be vi.fn()-able.
    registerProviderMock = vi.fn(() => ({ dispose: vi.fn() }));
    (vscode.languages as any).registerInlineCompletionItemProvider = registerProviderMock;
    registerCommandMock = vi.fn(() => ({ dispose: vi.fn() }));
    (vscode.commands as any).registerCommand = registerCommandMock;
    showInputBoxMock = vi.fn();
    (vscode.window as any).showInputBox = showInputBoxMock;
    getConfigMock = vi.fn(() => ({
        get: <T>(_k: string, d: T) => d,
        update: vi.fn(async () => undefined),
    }));
    (vscode.workspace as any).getConfiguration = getConfigMock;
    executeCommandMock = vi.fn();
    (vscode.commands as any).executeCommand = executeCommandMock;

    // Default activeTextEditor with a single selection. The provider bails
    // early when there's no active editor or > 1 selection.
    (vscode.window as any).activeTextEditor = {
        selections: [{}],
        document: { uri: { scheme: 'file' } },
    };

    // secrets storage
    secretsStoreMock = vi.fn();
    secretsGetMock = vi.fn();
    secretsDeleteMock = vi.fn();
    const secrets = {
        store: secretsStoreMock,
        get: secretsGetMock,
        delete: secretsDeleteMock,
        onDidChange: vi.fn(),
    };
    context = {
        subscriptions: [],
        secrets,
    } as any;

    // Other module mocks
    vi.spyOn(configModule, 'loadConfig').mockImplementation(() => baseCfg());
    vi.spyOn(cacheModule.LruCache, 'get').mockReturnValue(mockCache());
    vi.spyOn(cacheModule.LruCache, 'resetForTests').mockImplementation(() => {});
    vi.spyOn(postprocessModule, 'postprocess').mockImplementation((raw) => raw);

    vi.useFakeTimers();
    activate(context);
    // The first call to registerInlineCompletionItemProvider carries the provider.
    provider = registerProviderMock.mock.calls[0]?.[1];
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

/* ---------- activate ---------- */

describe('activate', () => {
    it('registers an inline completion provider', () => {
        expect(registerProviderMock).toHaveBeenCalled();
    });

    it('registers setApiKey, clearApiKey, and toggleEnabled commands', () => {
        const calls = registerCommandMock.mock.calls.map((c: any) => c[0]);
        expect(calls).toContain('dumbLlmAutocomplete.setApiKey');
        expect(calls).toContain('dumbLlmAutocomplete.clearApiKey');
        expect(calls).toContain('dumbLlmAutocomplete.toggleEnabled');
    });

    it('pushes the registered items to context.subscriptions', () => {
        expect(context.subscriptions.length).toBeGreaterThan(0);
    });

    it('does not crash when activated with no apiKey', () => {
        expect(() => activate(context)).not.toThrow();
    });
});

describe('deactivate', () => {
    it('closes the cache singleton', () => {
        const close = vi.fn();
        vi.spyOn(cacheModule.LruCache, 'get').mockReturnValue(mockCache({ close }));
        deactivate();
        expect(close).toHaveBeenCalled();
    });
});

/* ---------- setApiKey / clearApiKey commands ---------- */

describe('setApiKey command', () => {
    it('stores a non-empty value', async () => {
        showInputBoxMock.mockResolvedValue('my-key');
        const setApiKeyCmd = registerCommandMock.mock.calls
            .find((c) => c[0] === 'dumbLlmAutocomplete.setApiKey')![1];
        await setApiKeyCmd();
        expect(secretsStoreMock).toHaveBeenCalledWith('dumbLlmAutocomplete.apiKey', 'my-key');
    });

    it('clears the key when input is empty', async () => {
        showInputBoxMock.mockResolvedValue('');
        const setApiKeyCmd = registerCommandMock.mock.calls
            .find((c) => c[0] === 'dumbLlmAutocomplete.setApiKey')![1];
        await setApiKeyCmd();
        expect(secretsDeleteMock).toHaveBeenCalledWith('dumbLlmAutocomplete.apiKey');
    });

    it('does nothing on cancel', async () => {
        showInputBoxMock.mockResolvedValue(undefined);
        const setApiKeyCmd = registerCommandMock.mock.calls
            .find((c) => c[0] === 'dumbLlmAutocomplete.setApiKey')![1];
        await setApiKeyCmd();
        expect(secretsStoreMock).not.toHaveBeenCalled();
        expect(secretsDeleteMock).not.toHaveBeenCalled();
    });
});

describe('clearApiKey command', () => {
    it('clears the stored key', async () => {
        const clearCmd = registerCommandMock.mock.calls
            .find((c) => c[0] === 'dumbLlmAutocomplete.clearApiKey')![1];
        await clearCmd();
        expect(secretsDeleteMock).toHaveBeenCalledWith('dumbLlmAutocomplete.apiKey');
    });
});

describe('toggleEnabled command', () => {
    it('flips enabled from true to false', async () => {
        const update = vi.fn(async () => undefined);
        (vscode.workspace as any).getConfiguration = vi.fn(() => ({
            get: <T>(_k: string, d: T) => d,
            update,
        }));
        const toggle = registerCommandMock.mock.calls
            .find((c) => c[0] === 'dumbLlmAutocomplete.toggleEnabled')![1];
        await toggle();
        expect(update).toHaveBeenCalledWith('enabled', false, expect.anything());
    });
});

/* ---------- InlineProvider.provideInlineCompletionItems ---------- */

describe('InlineProvider', () => {
    describe('early bails', () => {
        it('returns [] when disabled', async () => {
            vi.spyOn(configModule, 'loadConfig').mockReturnValue(baseCfg({ enabled: false }));
            const doc = makeDocument('/src/file.ts', ['const x = foo']);
            const pos = makePosition(0, 13);
            const out = await provider.provideInlineCompletionItems(doc, pos, makeContext(), makeToken());
            expect(out).toEqual([]);
        });

        it('returns [] when apiEndpoint is empty', async () => {
            vi.spyOn(configModule, 'loadConfig').mockReturnValue(baseCfg({ apiEndpoint: '' }));
            const doc = makeDocument('/src/file.ts', ['const x = foo']);
            const pos = makePosition(0, 13);
            const out = await provider.provideInlineCompletionItems(doc, pos, makeContext(), makeToken());
            expect(out).toEqual([]);
        });

        it('returns [] for sensitive paths (.env)', async () => {
            const doc = makeDocument('/home/user/.env', ['KEY=value']);
            const pos = makePosition(0, 10);
            const out = await provider.provideInlineCompletionItems(doc, pos, makeContext(), makeToken());
            expect(out).toEqual([]);
        });

        it('returns [] for sensitive paths (.git/)', async () => {
            const doc = makeDocument('/home/user/.git/config', ['[core]']);
            const pos = makePosition(0, 7);
            const out = await provider.provideInlineCompletionItems(doc, pos, makeContext(), makeToken());
            expect(out).toEqual([]);
        });

        it('returns [] for sensitive paths (node_modules/)', async () => {
            const doc = makeDocument('/proj/node_modules/lib/index.js', ['exports.x = 1;']);
            const pos = makePosition(0, 14);
            const out = await provider.provideInlineCompletionItems(doc, pos, makeContext(), makeToken());
            expect(out).toEqual([]);
        });

        it('returns [] for sensitive paths (.vscode/)', async () => {
            const doc = makeDocument('/proj/.vscode/settings.json', ['{}']);
            const pos = makePosition(0, 2);
            const out = await provider.provideInlineCompletionItems(doc, pos, makeContext(), makeToken());
            expect(out).toEqual([]);
        });

        it('returns [] for vscode-scm scheme', async () => {
            const doc = {
                languageId: 'plaintext',
                lineCount: 1,
                lineAt: () => ({ text: '', range: { end: { character: 0 } } }),
                getText: () => '',
                uri: { fsPath: '', toString: () => 'vscode-scm://git', scheme: 'vscode-scm' },
            } as any;
            const pos = makePosition(0, 0);
            const out = await provider.provideInlineCompletionItems(doc, pos, makeContext(), makeToken());
            expect(out).toEqual([]);
        });

        it('returns [] for multi-cursor', async () => {
            (vscode.window as any).activeTextEditor = {
                selections: [{}, {}],
            };
            const doc = makeDocument('/src/file.ts', ['const x = foo']);
            const pos = makePosition(0, 13);
            const out = await provider.provideInlineCompletionItems(doc, pos, makeContext(), makeToken());
            expect(out).toEqual([]);
            (vscode.window as any).activeTextEditor = undefined;
        });
    });

    describe('selectedCompletionInfo gating', () => {
        it('returns [] when typed text is shorter than 4 chars', async () => {
            const doc = makeDocument('/src/file.ts', ['foo()']);
            const pos = makePosition(0, 5);
            const ctx = makeContext({
                selectedCompletionInfo: {
                    text: 'bar',
                    range: new vscode.Range(makePosition(0, 0), makePosition(0, 3)),
                },
            });
            const out = await provider.provideInlineCompletionItems(doc, pos, ctx, makeToken());
            expect(out).toEqual([]);
        });

        it('returns [] when selected.text does not start with typed text', async () => {
            const doc = makeDocument('/src/file.ts', ['foo()']);
            const pos = makePosition(0, 5);
            const ctx = makeContext({
                selectedCompletionInfo: {
                    text: 'World',
                    range: new vscode.Range(makePosition(0, 0), makePosition(0, 5)),
                },
            });
            const out = await provider.provideInlineCompletionItems(doc, pos, ctx, makeToken());
            expect(out).toEqual([]);
        });
    });

    describe('non-Invoke trigger debounces', () => {
        it('schedules an editor.action.inlineSuggest.trigger', async () => {
            const doc = makeDocument('/src/file.ts', ['const x = foo']);
            const pos = makePosition(0, 13);
            const ctx = makeContext({ triggerKind: vscode.InlineCompletionTriggerKind.Automatic });
            const out = await provider.provideInlineCompletionItems(doc, pos, ctx, makeToken());
            expect(out).toEqual([]);
            expect(executeCommandMock).not.toHaveBeenCalledWith('editor.action.inlineSuggest.trigger');
            // Advance fake timers.
            await vi.advanceTimersByTimeAsync(1000);
            expect(executeCommandMock).toHaveBeenCalledWith('editor.action.inlineSuggest.trigger');
        });
    });

    describe('Automatic trigger — cache serving', () => {
        it('returns a cached completion immediately on cache hit', async () => {
            const get = vi.fn(() => 'cached_x');
            vi.spyOn(cacheModule.LruCache, 'get').mockReturnValue(mockCache({ get }));
            const streamSpy = vi.spyOn(streamingModule, 'streamCompletion').mockImplementation(async function* () {
                yield 'should not be reached';
            });
            const doc = makeDocument('/src/file.ts', ['']);
            const pos = makePosition(0, 0);
            const out = await provider.provideInlineCompletionItems(
                doc, pos,
                makeContext({ triggerKind: vscode.InlineCompletionTriggerKind.Automatic }),
                makeToken(),
            );
            const items = itemsOf(out);
            expect(items.length).toBe(1);
            expect(items[0].insertText).toBe('cached_x');
            expect(streamSpy).not.toHaveBeenCalled();
            // Hit returns immediately — no debounced re-trigger scheduled.
            await vi.advanceTimersByTimeAsync(1000);
            expect(executeCommandMock).not.toHaveBeenCalledWith('editor.action.inlineSuggest.trigger');
        });

        it('schedules the debounced re-trigger on cache miss', async () => {
            const get = vi.fn(() => undefined);
            vi.spyOn(cacheModule.LruCache, 'get').mockReturnValue(mockCache({ get }));
            const doc = makeDocument('/src/file.ts', ['const x = foo']);
            const pos = makePosition(0, 13);
            const out = await provider.provideInlineCompletionItems(
                doc, pos,
                makeContext({ triggerKind: vscode.InlineCompletionTriggerKind.Automatic }),
                makeToken(),
            );
            expect(out).toEqual([]);
            expect(get).toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1000);
            expect(executeCommandMock).toHaveBeenCalledWith('editor.action.inlineSuggest.trigger');
        });

        it('skips the cache lookup on Automatic when useCache is false', async () => {
            vi.spyOn(configModule, 'loadConfig').mockReturnValue(baseCfg({ useCache: false }));
            const get = vi.fn(() => 'cached_x');
            vi.spyOn(cacheModule.LruCache, 'get').mockReturnValue(mockCache({ get }));
            const doc = makeDocument('/src/file.ts', ['const x = foo']);
            const pos = makePosition(0, 13);
            const out = await provider.provideInlineCompletionItems(
                doc, pos,
                makeContext({ triggerKind: vscode.InlineCompletionTriggerKind.Automatic }),
                makeToken(),
            );
            expect(out).toEqual([]);
            expect(get).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1000);
            expect(executeCommandMock).toHaveBeenCalledWith('editor.action.inlineSuggest.trigger');
        });
    });

    describe('Invoke trigger — happy path', () => {
        it('returns a single-line completion item with extraReplaceChars from suffix overlap', async () => {
            vi.spyOn(streamingModule, 'streamCompletion').mockImplementation(async function* () {
                yield 'foo';
            });
            const doc = makeDocument('/src/file.ts', ['foo()']);
            const pos = makePosition(0, 0);
            const out = await provider.provideInlineCompletionItems(doc, pos, makeContext(), makeToken());
            const items = itemsOf(out);
            expect(items.length).toBe(1);
            expect(items[0].insertText).toBe('foo');
            // Range covers the rest of the line (suffix is 'foo()' which is a
            // superset of the completion, so we replace all 5 chars).
            expect(items[0].range?.end.character).toBe(5);
        });

        it('caches the cleaned completion when useCache is true', async () => {
            const put = vi.fn();
            vi.spyOn(cacheModule.LruCache, 'get').mockReturnValue(mockCache({ put }));
            vi.spyOn(streamingModule, 'streamCompletion').mockImplementation(async function* () {
                yield 'foo()';
            });
            const doc = makeDocument('/src/file.ts', ['const x = foo()']);
            const pos = makePosition(0, 0);
            await provider.provideInlineCompletionItems(doc, pos, makeContext(), makeToken());
            expect(put).toHaveBeenCalled();
        });

        it('skips cache.put when useCache is false', async () => {
            vi.spyOn(configModule, 'loadConfig').mockReturnValue(baseCfg({ useCache: false }));
            const put = vi.fn();
            vi.spyOn(cacheModule.LruCache, 'get').mockReturnValue(mockCache({ put }));
            vi.spyOn(streamingModule, 'streamCompletion').mockImplementation(async function* () {
                yield 'foo()';
            });
            const doc = makeDocument('/src/file.ts', ['const x = foo()']);
            const pos = makePosition(0, 0);
            await provider.provideInlineCompletionItems(doc, pos, makeContext(), makeToken());
            expect(put).not.toHaveBeenCalled();
        });

        it('does not consult the cache on Invoke trigger — always streams fresh', async () => {
            const get = vi.fn(() => 'cached_completion');
            vi.spyOn(cacheModule.LruCache, 'get').mockReturnValue(mockCache({ get }));
            const streamSpy = vi.spyOn(streamingModule, 'streamCompletion').mockImplementation(async function* () {
                yield 'foo';
            });
            const doc = makeDocument('/src/file.ts', ['const x = foo()']);
            const pos = makePosition(0, 0);
            await provider.provideInlineCompletionItems(doc, pos, makeContext(), makeToken());
            expect(get).not.toHaveBeenCalled();
            expect(streamSpy).toHaveBeenCalled();
        });

        it('returns [] on stream error', async () => {
            vi.spyOn(streamingModule, 'streamCompletion').mockImplementation(async function* () {
                throw new Error('boom');
            });
            const doc = makeDocument('/src/file.ts', ['const x = foo()']);
            const pos = makePosition(0, 0);
            const out = await provider.provideInlineCompletionItems(doc, pos, makeContext(), makeToken());
            expect(out).toEqual([]);
        });

        it('returns [] when stream yields nothing', async () => {
            vi.spyOn(streamingModule, 'streamCompletion').mockImplementation(async function* () {
                // empty
            });
            const doc = makeDocument('/src/file.ts', ['const x = foo()']);
            const pos = makePosition(0, 0);
            const out = await provider.provideInlineCompletionItems(doc, pos, makeContext(), makeToken());
            expect(out).toEqual([]);
        });

        it('returns [] when postprocess returns undefined', async () => {
            vi.spyOn(streamingModule, 'streamCompletion').mockImplementation(async function* () {
                yield 'something';
            });
            vi.spyOn(postprocessModule, 'postprocess').mockReturnValue(undefined);
            const doc = makeDocument('/src/file.ts', ['const x = foo()']);
            const pos = makePosition(0, 0);
            const out = await provider.provideInlineCompletionItems(doc, pos, makeContext(), makeToken());
            expect(out).toEqual([]);
        });
    });

    describe('multi-line completion', () => {
        it('returns a range up to end of line for multi-line completions', async () => {
            vi.spyOn(streamingModule, 'streamCompletion').mockImplementation(async function* () {
                yield 'a\nb';
            });
            const doc = makeDocument('/src/file.ts', ['function foo() {', '  ']);
            const pos = makePosition(1, 2);
            // We need a config that yields multiline — easiest is multiline=always.
            vi.spyOn(configModule, 'loadConfig').mockReturnValue(baseCfg({ multiline: 'always' }));
            const out = await provider.provideInlineCompletionItems(doc, pos, makeContext(), makeToken());
            const items = itemsOf(out);
            expect(items.length).toBe(1);
            expect(items[0].insertText).toBe('a\nb');
        });
    });

    describe('selectedCompletionInfo prepend', () => {
        it('returns [] when typed < 4 chars', async () => {
            vi.spyOn(streamingModule, 'streamCompletion').mockImplementation(async function* () {
                yield 'leted';
            });
            const doc = makeDocument('/src/file.ts', ['const de']);
            const pos = makePosition(0, 9);
            const ctx = makeContext({
                selectedCompletionInfo: {
                    text: 'deleted',
                    range: new vscode.Range(makePosition(0, 6), makePosition(0, 8)),
                },
            });
            const out = await provider.provideInlineCompletionItems(doc, pos, ctx, makeToken());
            expect(out).toEqual([]);
        });

        it('prepends the selected text when typed >= 4 chars and starts with typed', async () => {
            vi.spyOn(streamingModule, 'streamCompletion').mockImplementation(async function* () {
                yield 'leted';
            });
            // Force multiline=never so the single-line makeItem path is taken.
            vi.spyOn(configModule, 'loadConfig').mockReturnValue(baseCfg({ multiline: 'never' }));
            const doc = makeDocument('/src/file.ts', ['const dele']);
            const pos = makePosition(0, 10);
            const ctx = makeContext({
                selectedCompletionInfo: {
                    text: 'deleted',
                    range: new vscode.Range(makePosition(0, 6), makePosition(0, 10)),
                },
            });
            const out = await provider.provideInlineCompletionItems(doc, pos, ctx, makeToken());
            const items = itemsOf(out);
            expect(items.length).toBe(1);
            expect(items[0].insertText).toBe('deleted' + 'leted');
        });
    });
});
