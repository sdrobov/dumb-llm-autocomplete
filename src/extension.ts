import * as vscode from 'vscode';

import { loadConfig } from './config';
import { preparePrompt } from './prompt';
import { streamCompletion } from './streaming';
import { postprocess } from './postprocess';
import { processSingleLineCompletion } from './singleLine';
import { LruCache } from './cache';

const SECRET_KEY = 'dumbLlmAutocomplete.apiKey';
const output = vscode.window.createOutputChannel('Dumb LLM autocomplete');

// ponytail: prefilter list. Match by suffix on the basename or path.
// Add when a user reports a leak from one of these; the keys are broad on purpose.
const SENSITIVE_PATTERNS = ['.env', '.git/', 'node_modules/', '.vscode/'];

function isSensitive(document: vscode.TextDocument): boolean {
    const p = document.uri.fsPath || document.uri.toString();
    return SENSITIVE_PATTERNS.some((pat) => p.includes(pat));
}

class InlineProvider implements vscode.InlineCompletionItemProvider {
    private latestCallId = 0;
    private debounceTimer: ReturnType<typeof setTimeout> | undefined;
    private activeStream: Promise<void> | undefined;
    constructor(private secrets: vscode.SecretStorage) {}

    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken,
    ): Promise<vscode.InlineCompletionItem[]> {
        const cfg = loadConfig();
        const myCallId = ++this.latestCallId;
        const isStillLatest = () => myCallId === this.latestCallId;
        const log = (msg: string) => { if (cfg.debug) output.appendLine(`[debug] #${myCallId} ${msg}`); };
        log(`enter ${document.languageId} @ L${position.line}:${position.character} trigger=${context.triggerKind} selected=${context.selectedCompletionInfo ? 'yes' : 'no'}`);
        if (!cfg.enabled || !cfg.apiEndpoint) { log('bail: disabled or no endpoint'); return []; }
        if (!isStillLatest()) { log('bail: superseded at entry'); return []; }
        if (isSensitive(document)) { log(`bail: sensitive path: ${document.uri.fsPath}`); return []; }
        const active = vscode.window.activeTextEditor;
        if (!active || active.selections.length > 1) { log(`bail: no active editor or multi-cursor (${active?.selections.length})`); return []; }
        if (document.uri.scheme === 'vscode-scm') { log('bail: scm scheme'); return []; }

        // VS Code's own autocomplete widget: only handle if user has typed at least
        // 4 characters AND the chosen snippet is consistent with what they typed.
        const selected = context.selectedCompletionInfo;
        if (selected) {
            const typedLen = selected.range.end.character - selected.range.start.character;
            const typedText = document.getText(selected.range);
            log(`selected: text=${JSON.stringify(selected.text)} range=L${selected.range.start.line}:${selected.range.start.character}-L${selected.range.end.line}:${selected.range.end.character} typed=${JSON.stringify(typedText)} len=${typedLen}`);
            if (typedLen < 4) { log('bail: typedLen<4'); return []; }
            if (!selected.text.startsWith(typedText)) { log(`bail: selected.text doesn't start with typedText`); return []; }
        }

        // Automatic provider promises are cancelled by VS Code while its suggest
        // widget updates. Return immediately, then invoke a fresh provider call once
        // typing settles so VS Code can display the eventual result.
        if (context.triggerKind !== vscode.InlineCompletionTriggerKind.Invoke) {
            if (this.debounceTimer) clearTimeout(this.debounceTimer);
            // Automatic triggers: VS Code cancels in-flight provider promises while
            // its suggest widget updates, so we can't stream here. Serve a cached
            // completion immediately; otherwise re-invoke once typing settles.
            if (cfg.useCache) {
                const prepared = preparePrompt(document, position, cfg);
                const cached = LruCache.get().get(prepared.prunedPrefix);
                if (cached !== undefined && cached.length > 0) {
                    log(`cache hit: ${JSON.stringify(cached).slice(0, 80)}`);
                    return [makeItem(document, position, context, prepared, cached)];
                }
            }
            this.debounceTimer = setTimeout(() => {
                this.debounceTimer = undefined;
                if (!isStillLatest()) return;
                log('debounce elapsed: trigger inline suggestion');
                void vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
            }, cfg.debounceMs);
            log(`scheduled invoke in ${cfg.debounceMs}ms`);
            return [];
        }
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = undefined;
        }

        const prepared = preparePrompt(document, position, cfg);
        log(`prepared: multiline=${prepared.multiline} maxTokens=${prepared.maxTokens} prefixLen=${prepared.prunedPrefix.length}`);

        const apiKey = (await this.secrets.get(SECRET_KEY)) ?? undefined;

        // Invoke = user explicitly asked for a completion → always stream fresh;
        // the cache is only consulted on Automatic triggers (see above).

        if (!isStillLatest()) { log('bail: superseded before stream'); return []; }
        while (this.activeStream) {
            log('wait: stream in flight');
            await this.activeStream;
            if (!isStillLatest()) { log('bail: superseded while waiting for stream'); return []; }
        }

        let finishStream!: () => void;
        const activeStream = new Promise<void>((resolve) => { finishStream = resolve; });
        this.activeStream = activeStream;

        let raw = '';
        try {
            for await (const chunk of streamCompletion(cfg, apiKey, prepared, token)) {
                raw += chunk;
            }
            log(`streamed ${raw.length} chars`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            output.appendLine(`[error] ${msg}`);
            return [];
        } finally {
            finishStream();
            if (this.activeStream === activeStream) this.activeStream = undefined;
        }

        // The streamCompletion drains regardless of token cancellation. Drop the
        // result only if a newer request has superseded us.
        if (!isStillLatest()) { log(`bail: superseded after stream (drop ${raw.length} chars)`); return []; }
        if (raw.length === 0) { log(`bail: empty stream`); return []; }

        const cleaned = postprocess(raw, prepared.prunedPrefix);
        if (!cleaned) {
            log(`postprocess dropped: ${JSON.stringify(raw).slice(0, 200)}`);
            return [];
        }

        // Cache the cleaned result.
        if (cfg.useCache) LruCache.get().put(prepared.prunedPrefix, cleaned);

        log(`${document.languageId} ${prepared.multiline ? 'multi' : 'single'}-line @ L${position.line}:${position.character} → ${JSON.stringify(cleaned).slice(0, 200)}`);

        return [makeItem(document, position, context, prepared, cleaned)];
    }
}

function makeItem(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    prepared: import('./prompt').PreparedPrompt,
    completion: string,
): vscode.InlineCompletionItem {
    // VS Code's own autocomplete widget selection: prepend the chosen snippet and
    // anchor the replacement at the start of what the user typed.
    const selected = context.selectedCompletionInfo;
    const start: vscode.Position = selected ? selected.range.start : position;
    if (selected) {
        completion = selected.text + completion;
    }

    // Single-line: diff against the text already after the cursor and possibly
    // extend the replace range so the completion lines up with existing text.
    if (!prepared.multiline && !completion.includes('\n')) {
        const lineText = document.lineAt(position.line).text;
        const suffixOnLine = lineText.substring(position.character);
        const { completionText, extraReplaceChars } = processSingleLineCompletion(completion, suffixOnLine);
        if (completionText.length === 0) {
            // Model produced exactly what was already on the line → empty item.
            return new vscode.InlineCompletionItem('');
        }
        const end = new vscode.Position(
            position.line,
            position.character + extraReplaceChars,
        );
        return new vscode.InlineCompletionItem(completionText, new vscode.Range(start, end));
    }

    // Multi-line: range from start to end of the current line.
    const range = new vscode.Range(start, document.lineAt(start.line).range.end);
    return new vscode.InlineCompletionItem(completion, range);
}

async function setApiKey(secrets: vscode.SecretStorage): Promise<void> {
    const current = (await secrets.get(SECRET_KEY)) ?? '';
    const value = await vscode.window.showInputBox({
        prompt: 'Enter your OpenAI-compatible API key (leave empty to clear)',
        password: true,
        value: current,
        ignoreFocusOut: true,
    });
    if (value === undefined) return;
    if (value === '') {
        await secrets.delete(SECRET_KEY);
        vscode.window.showInformationMessage('Dumb LLM autocomplete: API key cleared.');
    } else {
        await secrets.store(SECRET_KEY, value);
        vscode.window.showInformationMessage('Dumb LLM autocomplete: API key saved.');
    }
}

async function clearApiKey(secrets: vscode.SecretStorage): Promise<void> {
    await secrets.delete(SECRET_KEY);
    vscode.window.showInformationMessage('Dumb LLM autocomplete: API key cleared.');
}

function registerToggleCommand(): vscode.Disposable {
    return vscode.commands.registerCommand('dumbLlmAutocomplete.toggleEnabled', async () => {
        const cfg = vscode.workspace.getConfiguration('dumbLlmAutocomplete');
        const current = cfg.get<boolean>('enabled', true);
        await cfg.update('enabled', !current, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Dumb LLM autocomplete: ${!current ? 'enabled' : 'disabled'}.`);
    });
}

export function activate(context: vscode.ExtensionContext): void {
    const provider = new InlineProvider(context.secrets);
    context.subscriptions.push(
        vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider),
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('dumbLlmAutocomplete.setApiKey', () => setApiKey(context.secrets)),
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('dumbLlmAutocomplete.clearApiKey', () => clearApiKey(context.secrets)),
    );
    context.subscriptions.push(registerToggleCommand());
}

export function deactivate(): void {
    LruCache.get().close();
}