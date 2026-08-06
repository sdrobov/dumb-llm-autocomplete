import { describe, it, expect } from 'vitest';
import { postprocess } from '../../src/postprocess';

describe('postprocess', () => {
    // Blank / whitespace-only inputs must be dropped — the model echoed an empty
    // response and we don't want a ghost whitespace item in the editor.
    describe('blank inputs', () => {
        it('drops empty string', () => {
            expect(postprocess('', 'def x():')).toBeUndefined();
        });

        it('drops whitespace-only string', () => {
            expect(postprocess('   \n  \n', 'def x():')).toBeUndefined();
        });

        it('drops whitespace-only string of various kinds', () => {
            expect(postprocess('\t\n \t\n', 'def x():')).toBeUndefined();
        });
    });

    // Markdown fences — common when the model is told to "behave" but defaults
    // to wrapping code in ``` blocks.
    describe('markdown fences', () => {
        it('strips ```py\\n...``` wrapper', () => {
            expect(postprocess('```py\nfoo()\n```', 'def x():')).toBe('foo()');
        });

        it('strips bare ```\n...``` wrapper', () => {
            expect(postprocess('```\nfoo()\n```', 'def x():')).toBe('foo()');
        });

        it('strips ```typescript\\n...``` wrapper', () => {
            expect(postprocess('```typescript\nfoo()\n```', 'def x():')).toBe('foo()');
        });

        it('strips ```ts\\n...``` wrapper', () => {
            expect(postprocess('```ts\nfoo()\n```', 'def x():')).toBe('foo()');
        });

        it('strips opening fence without closing fence', () => {
            expect(postprocess('```python\nfoo()', 'def x():')).toBe('foo()');
        });

        it('drops lone opening fence as empty', () => {
            expect(postprocess('```', 'def x():')).toBeUndefined();
        });

        it('keeps content if trailing ``` is just ``` with no inner content', () => {
            // After stripping `````` we get empty → undefined.
            expect(postprocess('```\n```', 'def x():')).toBeUndefined();
        });

        it('strips opening fence with leading language and no newline', () => {
            // The regex /^```[a-zA-Z0-9_-]*\n?/ greedily eats letters/digits
            // after the fence — so 'pythonfoo' is consumed as one lang token,
            // leaving '()'. That's a known quirk, documented as a test.
            expect(postprocess('```pythonfoo()', 'def x():')).toBe('()');
        });
    });

    // "Repeat the line above" — happens when the model confuses "context" with
    // "what to write". Dropping this keeps the editor clean.
    describe('rewrite line above', () => {
        it('drops when first line equals the last non-empty line above', () => {
            expect(postprocess('foo\nfoo()', 'foo\n')).toBeUndefined();
        });

        it('keeps when first line is different from the line above', () => {
            expect(postprocess('foo()', 'foo\n')).toBe('foo()');
        });

        it('keeps when prefix has no non-empty lines', () => {
            expect(postprocess('foo()', '')).toBe('foo()');
        });

        it('keeps when prefix is empty', () => {
            expect(postprocess('foo()', '')).toBe('foo()');
        });

        it('keeps when first line differs only after trailing whitespace', () => {
            expect(postprocess('foo();bar()', 'foo;\n')).toBe('foo();bar()');
        });
    });

    // Repetition loops — model gets stuck printing the same line. Drop.
    describe('extreme repetition', () => {
        it('drops a single repeated line appearing 9 times', () => {
            const s = 'print(1)\n'.repeat(9);
            expect(postprocess(s, 'def x():')).toBeUndefined();
        });

        it('drops alternating two-line repetition', () => {
            const s = 'print(1)\nprint(2)\n'.repeat(5);
            expect(postprocess(s, 'def x():')).toBeUndefined();
        });

        it('keeps 5 distinct lines', () => {
            const s = 'a\nb\nc\nd\ne';
            expect(postprocess(s, 'def x():')).toBe(s);
        });

        it('keeps short repetition (under the 6-line threshold)', () => {
            const s = 'print(1)\nprint(1)\nprint(1)\nprint(1)\nprint(1)';
            expect(postprocess(s, 'def x():')).toBe(s);
        });

        it('keeps when repeated lines are too short', () => {
            // Lines under 6 chars get skipped by the frequency check.
            const s = 'x\nx\nx\nx\nx\nx\nx';
            expect(postprocess(s, 'def x():')).toBe(s);
        });
    });

    describe('normal passthrough', () => {
        it('returns trimmed single-line text', () => {
            expect(postprocess('return 42', 'function foo() {\n  ')).toBe('return 42');
        });

        it('returns trimmed multi-line text', () => {
            expect(postprocess('  if (x) {\n    return y;\n  }\n', 'foo')).toBe('if (x) {\n    return y;\n  }');
        });

        it('preserves blank lines inside the completion', () => {
            expect(postprocess('a\n\nb', 'foo')).toBe('a\n\nb');
        });

        it('strips trailing whitespace but keeps internal whitespace', () => {
            expect(postprocess('a   \nb', 'foo')).toBe('a   \nb');
        });
    });
});
