import { describe, it, expect, vi } from 'vitest';

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
    // vscode.Range / Position accept either 4 numbers, 2 Positions, or 1
    // Position+object. We normalise to { start: {line,character}, end: {...} }.
    Range: class {
        start: { line: number; character: number };
        end: { line: number; character: number };
        constructor(a: any, b: any, c?: any, d?: any) {
            if (typeof a === 'number') {
                this.start = { line: a, character: b };
                this.end = { line: c as number, character: d as number };
            } else {
                this.start = a;
                this.end = b;
            }
        }
    },
    Position: class { constructor(public line: number, public character: number) {} },
    InlineCompletionItem: class { constructor(public insertText: string, public range?: unknown, public command?: unknown) {} },
    CancellationTokenSource: class { token = { isCancellationRequested: false, onCancellationRequested: () => undefined }; cancel() {} dispose() {} },
    CancellationToken: class { isCancellationRequested = false; onCancellationRequested = () => undefined; },
    SecretStorage: class { store = () => undefined; get = () => undefined; delete = () => undefined; onDidChange = () => undefined; },
    Disposable: class { constructor(_?: unknown) {} dispose = () => undefined; },
}));

import * as vscode from 'vscode';
import { preparePrompt } from '../../src/prompt';
import type { Config } from '../../src/config';

/* ---------- helpers ---------- */

function makeDocument(lines: string[], languageId = 'typescript'): vscode.TextDocument {
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
        uri: { fsPath: '/test/file.ts', toString: () => 'file:///test/file.ts', scheme: 'file' },
        fileName: '/test/file.ts',
        isUntitled: false,
        version: 1,
        isDirty: false,
        isClosed: false,
        save: async () => true,
        eol: 1,
        encoding: 'utf-8',
        notebook: undefined,
        isTransient: false,
        positionAt: (offset: number) => {
            let line = 0, char = 0;
            for (let i = 0; i < offset; i++) {
                if ((lines[line] ?? '').length === char) { line++; char = 0; }
                else char++;
            }
            return new vscode.Position(line, char);
        },
        offsetAt: () => 0,
        validateRange: (r: any) => r,
        validatePosition: (p: any) => p,
    } as any;
}

function baseCfg(overrides: Partial<Config> = {}): Config {
    return {
        enabled: true,
        apiEndpoint: 'http://localhost:11434',
        model: 'qwen2.5-coder',
        maxTokens: 256,
        temperature: 0.2,
        debounceMs: 750,
        contextLines: 50,
        timeoutMs: 15000,
        maxPromptTokens: 2048,
        multiline: 'auto',
        systemPrompt: 'system-prompt',
        useCache: true,
        debug: false,
        apiStyle: 'openai-compatible',
        ...overrides,
    };
}

/* ---------- tests ---------- */

describe('preparePrompt', () => {
    it('builds a prompt for cursor mid-expression', () => {
        // The empty suffix on the same line + no dot/arrow + not lone identifier
        // + not after bracket means shouldCompleteMultiline returns true.
        // The actual extension layer is what narrows this to single-line in
        // practice; preparePrompt itself doesn't enforce single-line.
        const doc = makeDocument(['const x = foo.b']);
        const pos = new vscode.Position(0, 16);
        const cfg = baseCfg();
        const p = preparePrompt(doc, pos, cfg);
        expect(p.prunedPrefix).toBe('const x = foo.b');
        expect(p.prunedSuffix).toBe('');
    });

    it('returns true for multiline=auto when cursor is at end of a mid-expression line', () => {
        const doc = makeDocument(['const x = foo.b']);
        const pos = new vscode.Position(0, 16);
        const p = preparePrompt(doc, pos, baseCfg());
        // No same-line suffix, no trailing dot/arrow, not lone identifier, not
        // after opening bracket → multiline is allowed.
        expect(p.multiline).toBe(true);
    });

    it('returns false for multiline=auto when there is text after the cursor on the same line', () => {
        // Multi-line document: the cursor is on line 0, but the document has
        // another line that starts with text — so the suffix has content.
        const doc = makeDocument(['const x = foo.', 'bar();']);
        const pos = new vscode.Position(0, 15);
        const p = preparePrompt(doc, pos, baseCfg());
        expect(p.multiline).toBe(false);
    });

    it('uses the qwen FIM template for qwen models', () => {
        const doc = makeDocument(['a', 'b']);
        const pos = new vscode.Position(0, 1);
        const cfg = baseCfg({ model: 'qwen2.5-coder-1.5b' });
        const p = preparePrompt(doc, pos, cfg);
        expect(p.userPrompt).toContain('<|fim_prefix|>');
        expect(p.userPrompt).toContain('<|fim_suffix|>');
        expect(p.userPrompt).toContain('<|fim_middle|>');
        expect(p.systemPrompt).toBe('system-prompt');
    });

    it('uses the chat-cursor template for gpt-style models', () => {
        const doc = makeDocument(['a', 'b']);
        const pos = new vscode.Position(0, 1);
        const cfg = baseCfg({ model: 'gpt-4' });
        const p = preparePrompt(doc, pos, cfg);
        expect(p.userPrompt).toContain('<CURSOR>');
        expect(p.userPrompt).toContain('```typescript');
    });

    it('caps maxTokens for multi-line completions', () => {
        const doc = makeDocument(['function foo() {', '  ', '}']);
        const pos = new vscode.Position(1, 2);
        const cfg = baseCfg({ maxTokens: 1024, multiline: 'always' });
        const p = preparePrompt(doc, pos, cfg);
        expect(p.multiline).toBe(true);
        expect(p.maxTokens).toBe(256);
    });

    it('passes the full maxTokens when not multiline (multiline=never)', () => {
        const doc = makeDocument(['const x = foo.b']);
        const pos = new vscode.Position(0, 16);
        const cfg = baseCfg({ maxTokens: 1024, multiline: 'never' });
        const p = preparePrompt(doc, pos, cfg);
        expect(p.multiline).toBe(false);
        expect(p.maxTokens).toBe(1024);
    });

    it('stops at \\n for single-line (appends it to template stop tokens)', () => {
        // Use multiline=never so shouldCompleteMultiline returns false, and
        // the stop tokens list gets '\n' appended.
        const doc = makeDocument(['const x = foo.b']);
        const pos = new vscode.Position(0, 16);
        const cfg = baseCfg({ model: 'gpt-4', multiline: 'never' });
        const p = preparePrompt(doc, pos, cfg);
        expect(p.multiline).toBe(false);
        expect(p.stop).toContain('\n');
    });

    it('does not add \\n to stop for multi-line', () => {
        const doc = makeDocument(['function foo() {', '  ', '}']);
        const pos = new vscode.Position(1, 2);
        const cfg = baseCfg({ model: 'gpt-4', multiline: 'always' });
        const p = preparePrompt(doc, pos, cfg);
        expect(p.multiline).toBe(true);
        expect(p.stop).not.toContain('\n');
    });

    it('respects contextLines for the slice window', () => {
        const lines: string[] = [];
        for (let i = 0; i < 200; i++) lines.push(`line${i}`);
        const doc = makeDocument(lines);
        const pos = new vscode.Position(150, 5);
        const cfg = baseCfg({ contextLines: 3 });
        const p = preparePrompt(doc, pos, cfg);
        expect(p.prunedPrefix).toContain('line147');
        // Position is at character 5, so the line 150 prefix is 'line1' (5 chars).
        expect(p.prunedPrefix).toContain('line1');
        expect(p.prunedPrefix).not.toContain('line0');
    });

    it('prunes prefix when larger than the budget', () => {
        const huge = 'x'.repeat(10_000);
        const doc = makeDocument([huge, 'cursor-here']);
        const pos = new vscode.Position(1, 0);
        const cfg = baseCfg({ maxPromptTokens: 800 });
        const p = preparePrompt(doc, pos, cfg);
        expect(p.prunedPrefix.length).toBeLessThan(10_000);
    });

    it('prunes suffix when larger than the budget', () => {
        const huge = 'y'.repeat(10_000);
        const doc = makeDocument(['cursor-here', huge]);
        const pos = new vscode.Position(0, 0);
        const cfg = baseCfg({ maxPromptTokens: 800 });
        const p = preparePrompt(doc, pos, cfg);
        expect(p.prunedSuffix.length).toBeLessThan(10_000);
    });

    it('handles empty document', () => {
        const doc = makeDocument(['']);
        const pos = new vscode.Position(0, 0);
        const cfg = baseCfg();
        const p = preparePrompt(doc, pos, cfg);
        expect(p.prunedPrefix).toBe('');
        expect(p.prunedSuffix).toBe('');
        expect(p.multiline).toBe(true);
    });

    it('uses the document language id in chat template', () => {
        const doc = makeDocument(['x', 'y'], 'python');
        const pos = new vscode.Position(0, 1);
        const cfg = baseCfg({ model: 'gpt-4' });
        const p = preparePrompt(doc, pos, cfg);
        expect(p.userPrompt).toContain('```python');
    });

    it('respects multiline=always even mid-line', () => {
        const doc = makeDocument(['foo.']);
        const pos = new vscode.Position(0, 4);
        const cfg = baseCfg({ multiline: 'always' });
        const p = preparePrompt(doc, pos, cfg);
        expect(p.multiline).toBe(true);
    });

    it('respects multiline=never even at top of function', () => {
        const doc = makeDocument(['function foo() {', '  ', '}']);
        const pos = new vscode.Position(1, 2);
        const cfg = baseCfg({ multiline: 'never' });
        const p = preparePrompt(doc, pos, cfg);
        expect(p.multiline).toBe(false);
    });

    it('handles deepseek template', () => {
        const doc = makeDocument(['a', 'b']);
        const pos = new vscode.Position(0, 1);
        const cfg = baseCfg({ model: 'deepseek-coder' });
        const p = preparePrompt(doc, pos, cfg);
        expect(p.userPrompt).toContain('<|fim▁begin|>');
        expect(p.userPrompt).toContain('<|fim▁hole|>');
        expect(p.userPrompt).toContain('<|fim▁end|>');
    });
});
