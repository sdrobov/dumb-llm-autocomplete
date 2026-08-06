import { describe, it, expect } from 'vitest';
import { endpointFor, stripTrailingPath } from '../../src/streaming';

describe('stripTrailingPath', () => {
    it('returns the bare URL unchanged', () => {
        expect(stripTrailingPath('http://localhost:11434')).toBe('http://localhost:11434');
    });

    it('strips trailing slashes', () => {
        expect(stripTrailingPath('http://localhost:11434/')).toBe('http://localhost:11434');
        expect(stripTrailingPath('http://localhost:11434///')).toBe('http://localhost:11434');
    });

    it('strips /v1/chat/completions', () => {
        expect(stripTrailingPath('http://localhost:11434/v1/chat/completions')).toBe('http://localhost:11434');
        expect(stripTrailingPath('http://localhost:11434/v1/chat/completions/')).toBe('http://localhost:11434');
    });

    it('strips /api/generate', () => {
        expect(stripTrailingPath('http://localhost:11434/api/generate')).toBe('http://localhost:11434');
    });

    it('strips /api/chat', () => {
        expect(stripTrailingPath('http://localhost:11434/api/chat')).toBe('http://localhost:11434');
    });

    it('strips bare /v1', () => {
        expect(stripTrailingPath('https://api.openai.com/v1')).toBe('https://api.openai.com');
        expect(stripTrailingPath('https://api.openai.com/v1/')).toBe('https://api.openai.com');
    });

    it('falls back to default Ollama URL when empty', () => {
        expect(stripTrailingPath('')).toBe('http://localhost:11434');
    });

    it('falls back to default Ollama URL when only slashes', () => {
        expect(stripTrailingPath('/')).toBe('http://localhost:11434');
    });
});

describe('endpointFor', () => {
    describe('openai-compatible style', () => {
        it('appends /v1/chat/completions to bare URL', () => {
            expect(endpointFor('http://localhost:11434', 'openai-compatible'))
                .toBe('http://localhost:11434/v1/chat/completions');
        });

        it('appends /v1/chat/completions to URL with trailing slash', () => {
            expect(endpointFor('http://localhost:11434/', 'openai-compatible'))
                .toBe('http://localhost:11434/v1/chat/completions');
        });

        it('passes through full chat-completions URL', () => {
            expect(endpointFor('http://localhost:11434/v1/chat/completions', 'openai-compatible'))
                .toBe('http://localhost:11434/v1/chat/completions');
        });

        it('appends chat to OpenAI base', () => {
            expect(endpointFor('https://api.openai.com', 'openai-compatible'))
                .toBe('https://api.openai.com/v1/chat/completions');
        });

        it('appends chat to OpenAI /v1 base', () => {
            expect(endpointFor('https://api.openai.com/v1', 'openai-compatible'))
                .toBe('https://api.openai.com/v1/chat/completions');
        });

        it('works with LM Studio default port', () => {
            expect(endpointFor('http://localhost:1234', 'openai-compatible'))
                .toBe('http://localhost:1234/v1/chat/completions');
        });

        it('falls back to localhost Ollama when endpoint is empty', () => {
            expect(endpointFor('', 'openai-compatible'))
                .toBe('http://localhost:11434/v1/chat/completions');
        });
    });

    describe('ollama-native style', () => {
        it('appends /api/generate to bare URL', () => {
            expect(endpointFor('http://localhost:11434', 'ollama-native'))
                .toBe('http://localhost:11434/api/generate');
        });

        it('appends /api/generate to URL with trailing slash', () => {
            expect(endpointFor('http://localhost:11434/', 'ollama-native'))
                .toBe('http://localhost:11434/api/generate');
        });

        it('replaces legacy chat path with /api/generate', () => {
            expect(endpointFor('http://localhost:11434/v1/chat/completions', 'ollama-native'))
                .toBe('http://localhost:11434/api/generate');
        });

        it('passes through /api/generate', () => {
            expect(endpointFor('http://localhost:11434/api/generate', 'ollama-native'))
                .toBe('http://localhost:11434/api/generate');
        });
    });
});
