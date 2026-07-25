import * as vscode from 'vscode';

import type { Config } from './config';
import { shouldCompleteMultiline, maxTokensForMultiline } from './multiline';
import { getTemplateForModel } from './templates';

export interface PreparedPrompt {
    /** System prompt to send. Empty string if the template overrides it. */
    systemPrompt: string;
    /** User message body. Used by chat completions; ignored by Ollama native (where prompt+suffix fields are sent separately). */
    userPrompt: string;
    prunedPrefix: string;
    prunedSuffix: string;
    multiline: boolean;
    maxTokens: number;
    /** Stop tokens to pass in the API request. */
    stop: string[];
}

// ponytail: char-based budgeting. 1 token ≈ 4 chars is good enough for "don't overflow".
const CHARS_PER_TOKEN = 4;

function budgetChars(tokens: number): number {
    return Math.max(200, Math.floor(tokens * CHARS_PER_TOKEN));
}

function pruneFromTop(s: string, maxChars: number): string {
    if (s.length <= maxChars) return s;
    let cut = s.length - maxChars;
    const nl = s.indexOf('\n', cut);
    if (nl !== -1 && nl < s.length - 1) cut = nl + 1;
    return s.slice(cut);
}

function pruneFromBottom(s: string, maxChars: number): string {
    if (s.length <= maxChars) return s;
    let cut = maxChars;
    const nl = s.lastIndexOf('\n', cut);
    if (nl > 0) cut = nl;
    return s.slice(0, cut);
}

export function preparePrompt(
    document: vscode.TextDocument,
    position: vscode.Position,
    cfg: Config,
): PreparedPrompt {
    const startLine = Math.max(0, position.line - cfg.contextLines);
    const endLine = Math.min(document.lineCount - 1, position.line + cfg.contextLines);

    const rawPrefix = document.getText(new vscode.Range(startLine, 0, position.line, position.character));
    const endOfEndLine = document.lineAt(endLine).text.length;
    const rawSuffix = document.getText(
        new vscode.Range(position.line, position.character, endLine, endOfEndLine),
    );

    const prefixBudget = budgetChars(Math.floor(cfg.maxPromptTokens * 0.6));
    const suffixBudget = budgetChars(Math.floor(cfg.maxPromptTokens * 0.4));
    const prunedPrefix = pruneFromTop(rawPrefix, prefixBudget);
    const prunedSuffix = pruneFromBottom(rawSuffix, suffixBudget);

    const multiline = shouldCompleteMultiline(prunedPrefix, prunedSuffix, cfg.multiline);
    const maxTokens = maxTokensForMultiline(cfg.maxTokens, multiline);

    const lang = document.languageId || '';
    const template = getTemplateForModel(cfg.model);

    // FIM templates override the system prompt entirely — they're raw completion
    // prompts and instruction-following models add noise on top.
    const systemPrompt = template.systemPrompt ?? cfg.systemPrompt;
    const userPrompt = template.userPrompt(prunedPrefix, prunedSuffix, lang);

    return {
        systemPrompt,
        userPrompt,
        prunedPrefix,
        prunedSuffix,
        multiline,
        maxTokens,
        stop: multiline ? template.stop : [...template.stop, '\n'],
    };
}