import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => undefined,
        onDidChangeConfiguration: () => undefined,
    },
    window: {
        createOutputChannel: () => undefined,
        showInformationMessage: () => undefined,
        showWarningMessage: () => undefined,
        showErrorMessage: () => undefined,
        showInputBox: () => undefined,
        activeTextEditor: undefined,
    },
    languages: { registerInlineCompletionItemProvider: () => undefined },
    commands: { registerCommand: () => undefined, executeCommand: () => undefined },
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
import { loadConfig } from '../../src/config';

function setConfig(values: Record<string, unknown>): void {
    (vscode.workspace.getConfiguration as any) = vi.fn(() => ({
        get: <T>(key: string, def: T) =>
            (key in values ? (values[key] as T) : def),
    }));
}

beforeEach(() => {
    setConfig({});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('loadConfig', () => {
    it('returns defaults when nothing is set', () => {
        const cfg = loadConfig();
        expect(cfg.enabled).toBe(true);
        expect(cfg.apiEndpoint).toBe('');
        expect(cfg.model).toBe('gpt-3.5-turbo');
        expect(cfg.maxTokens).toBe(256);
        expect(cfg.temperature).toBe(0.2);
        expect(cfg.debounceMs).toBe(750);
        expect(cfg.contextLines).toBe(50);
        expect(cfg.timeoutMs).toBe(15000);
        expect(cfg.maxPromptTokens).toBe(2048);
        expect(cfg.multiline).toBe('auto');
        expect(cfg.useCache).toBe(true);
        expect(cfg.debug).toBe(false);
        expect(cfg.apiStyle).toBe('openai-compatible');
    });

    it('returns the system-prompt default when no value is set', () => {
        const cfg = loadConfig();
        expect(cfg.systemPrompt).toContain('autocomplete engine');
        expect(cfg.systemPrompt).toContain('Return only the text to insert');
    });

    it('reads enabled', () => {
        setConfig({ enabled: false });
        expect(loadConfig().enabled).toBe(false);
    });

    it('reads model', () => {
        setConfig({ model: 'qwen2.5-coder' });
        expect(loadConfig().model).toBe('qwen2.5-coder');
    });

    it('reads maxTokens', () => {
        setConfig({ maxTokens: 1024 });
        expect(loadConfig().maxTokens).toBe(1024);
    });

    it('reads temperature', () => {
        setConfig({ temperature: 0.7 });
        expect(loadConfig().temperature).toBe(0.7);
    });

    it('reads debounceMs', () => {
        setConfig({ debounceMs: 100 });
        expect(loadConfig().debounceMs).toBe(100);
    });

    it('reads contextLines', () => {
        setConfig({ contextLines: 10 });
        expect(loadConfig().contextLines).toBe(10);
    });

    it('reads timeoutMs', () => {
        setConfig({ timeoutMs: 5000 });
        expect(loadConfig().timeoutMs).toBe(5000);
    });

    it('reads maxPromptTokens', () => {
        setConfig({ maxPromptTokens: 4096 });
        expect(loadConfig().maxPromptTokens).toBe(4096);
    });

    it('reads multiline mode', () => {
        setConfig({ multiline: 'always' });
        expect(loadConfig().multiline).toBe('always');
        setConfig({ multiline: 'never' });
        expect(loadConfig().multiline).toBe('never');
    });

    it('reads apiStyle', () => {
        setConfig({ apiStyle: 'ollama-native' });
        expect(loadConfig().apiStyle).toBe('ollama-native');
    });

    it('reads useCache', () => {
        setConfig({ useCache: false });
        expect(loadConfig().useCache).toBe(false);
    });

    it('reads debug', () => {
        setConfig({ debug: true });
        expect(loadConfig().debug).toBe(true);
    });

    it('trims apiEndpoint whitespace', () => {
        setConfig({ apiEndpoint: '  http://localhost:11434  ' });
        expect(loadConfig().apiEndpoint).toBe('http://localhost:11434');
    });

    it('reads custom system prompt', () => {
        setConfig({ systemPrompt: 'Be terse.' });
        expect(loadConfig().systemPrompt).toBe('Be terse.');
    });

    it('calls workspace.getConfiguration with the right namespace', () => {
        const getConfig = vi.fn(() => ({
            get: (_k: string, d: unknown) => d,
        }));
        (vscode.workspace as any).getConfiguration = getConfig;
        loadConfig();
        expect(getConfig).toHaveBeenCalledWith('dumbLlmAutocomplete');
    });
});
