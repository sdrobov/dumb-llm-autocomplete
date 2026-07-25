import * as vscode from 'vscode';

export interface Config {
    enabled: boolean;
    apiEndpoint: string;
    apiKey?: string;
    model: string;
    maxTokens: number;
    temperature: number;
    debounceMs: number;
    contextLines: number;
    timeoutMs: number;
    maxPromptTokens: number;
    multiline: 'always' | 'never' | 'auto';
    systemPrompt: string;
    useCache: boolean;
    debug: boolean;
    apiStyle: 'openai-compatible' | 'ollama-native';
}

const NAMESPACE = 'dumbLlmAutocomplete';

export function loadConfig(): Config {
    const c = vscode.workspace.getConfiguration(NAMESPACE);
    return {
        enabled: c.get<boolean>('enabled', true),
        apiEndpoint: c.get<string>('apiEndpoint', '').trim(),
        model: c.get<string>('model', 'gpt-3.5-turbo'),
        maxTokens: c.get<number>('maxTokens', 256),
        temperature: c.get<number>('temperature', 0.2),
        debounceMs: c.get<number>('debounceMs', 750),
        contextLines: c.get<number>('contextLines', 50),
        timeoutMs: c.get<number>('timeoutMs', 15000),
        maxPromptTokens: c.get<number>('maxPromptTokens', 2048),
        multiline: c.get<'always' | 'never' | 'auto'>('multiline', 'auto'),
        systemPrompt: c.get<string>(
            'systemPrompt',
            `You are an autocomplete engine.

Complete the code at the cursor.

Return only the text to insert.

Do not explain.

Do not repeat existing code.

Do not wrap in markdown.

Keep the completion minimal.

Preserve formatting.`,
        ),
        useCache: c.get<boolean>('useCache', true),
        debug: c.get<boolean>('debug', false),
        apiStyle: c.get<'openai-compatible' | 'ollama-native'>('apiStyle', 'openai-compatible'),
    };
}
