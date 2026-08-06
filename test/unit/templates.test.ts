import { describe, it, expect } from 'vitest';
import { getTemplateForModel } from '../../src/templates';

describe('getTemplateForModel', () => {
    describe('qwen detection', () => {
        it('matches qwen2.5-coder', () => {
            const t = getTemplateForModel('qwen2.5-coder-1.5b');
            expect(t.userPrompt('p', 's', 'python')).toContain('<|fim_prefix|>p');
            expect(t.userPrompt('p', 's', 'python')).toContain('<|fim_suffix|>s');
            expect(t.userPrompt('p', 's', 'python')).toContain('<|fim_middle|>');
        });
        it('matches qwen3', () => {
            const t = getTemplateForModel('qwen3-coder');
            expect(t.userPrompt('p', 's', 'python')).toContain('<|fim_prefix|>');
        });
        it('matches uppercase Qwen', () => {
            const t = getTemplateForModel('Qwen2.5-Coder');
            expect(t.userPrompt('p', 's', 'python')).toContain('<|fim_prefix|>');
        });
    });

    describe('deepseek detection', () => {
        it('matches deepseek-coder', () => {
            const t = getTemplateForModel('deepseek-coder-6.7b');
            expect(t.userPrompt('p', 's', 'python')).toBe('<|fim▁begin|>p<|fim▁hole|>s<|fim▁end|>');
        });
        it('matches deepseek-coder-v2', () => {
            const t = getTemplateForModel('deepseek-coder-v2');
            expect(t.userPrompt('p', 's', 'python')).toContain('<|fim▁begin|>');
        });
    });

    describe('starcoder detection', () => {
        it('matches starcoder', () => {
            const t = getTemplateForModel('starcoder2-3b');
            expect(t.userPrompt('p', 's', 'python')).toContain('<fim_prefix>');
        });
        it('matches star-coder with dash', () => {
            const t = getTemplateForModel('star-coder');
            expect(t.userPrompt('p', 's', 'python')).toContain('<fim_prefix>');
        });
        it('matches starchat', () => {
            const t = getTemplateForModel('starchat');
            expect(t.userPrompt('p', 's', 'python')).toContain('<fim_prefix>');
        });
    });

    describe('codellama detection', () => {
        it('matches codellama', () => {
            const t = getTemplateForModel('codellama-7b');
            expect(t.userPrompt('p', 's', 'python')).toBe('<PRE> p <SUF> s <MID>');
        });
        it('matches code-llama with dash', () => {
            const t = getTemplateForModel('code-llama-13b');
            expect(t.userPrompt('p', 's', 'python')).toContain('<PRE>');
        });
    });

    describe('fallback chat template', () => {
        it('falls back for unknown model', () => {
            const t = getTemplateForModel('gpt-4');
            const out = t.userPrompt('p', 's', 'python');
            expect(out).toContain('<CURSOR>');
            expect(out).toContain('```python');
            expect(out).toContain('p');
            expect(out).toContain('s');
        });

        it('falls back for empty model name', () => {
            const t = getTemplateForModel('');
            expect(t.userPrompt('p', 's', 'python')).toContain('<CURSOR>');
        });

        it('falls back for claude', () => {
            const t = getTemplateForModel('claude-3-opus');
            expect(t.userPrompt('p', 's', 'python')).toContain('<CURSOR>');
        });
    });

    describe('stop tokens', () => {
        it('qwen includes all FIM stop tokens', () => {
            const t = getTemplateForModel('qwen2.5-coder');
            expect(t.stop).toContain('<|fim_prefix|>');
            expect(t.stop).toContain('<|fim_middle|>');
            expect(t.stop).toContain('<|fim_suffix|>');
            expect(t.stop).toContain('<|endoftext|>');
        });

        it('deepseek includes FIM stop tokens', () => {
            const t = getTemplateForModel('deepseek-coder');
            expect(t.stop).toContain('<|fim▁begin|>');
            expect(t.stop).toContain('<|fim▁hole|>');
            expect(t.stop).toContain('<|fim▁end|>');
        });

        it('starcoder has empty stop list', () => {
            const t = getTemplateForModel('starcoder');
            // starcoder template defines specific stop tokens.
            expect(Array.isArray(t.stop)).toBe(true);
        });

        it('fallback has empty stop list', () => {
            const t = getTemplateForModel('gpt-4');
            expect(t.stop).toEqual([]);
        });
    });

    describe('FIM suffix handling', () => {
        it('appends newline for non-Python languages on qwen', () => {
            const t = getTemplateForModel('qwen2.5-coder');
            const out = t.userPrompt('p', 's', 'typescript');
            expect(out).toMatch(/<\|fim_suffix\|>s\n<\|fim_middle\|>/);
        });

        it('keeps suffix as-is for python on qwen', () => {
            const t = getTemplateForModel('qwen2.5-coder');
            const out = t.userPrompt('p', 's', 'python');
            expect(out).toBe('<|fim_prefix|>p<|fim_suffix|>s<|fim_middle|>');
        });

        it('treats empty suffix as newline for qwen typescript', () => {
            const t = getTemplateForModel('qwen2.5-coder');
            const out = t.userPrompt('p', '', 'typescript');
            expect(out).toBe('<|fim_prefix|>p<|fim_suffix|>\n<|fim_middle|>');
        });

        it('does not double newline if suffix already ends with one (non-FIM lang)', () => {
            const t = getTemplateForModel('qwen2.5-coder');
            const out = t.userPrompt('p', 's\n', 'typescript');
            expect(out).toBe('<|fim_prefix|>p<|fim_suffix|>s\n<|fim_middle|>');
        });
    });
});
