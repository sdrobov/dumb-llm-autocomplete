import { describe, it, expect } from 'vitest';
import { processSingleLineCompletion } from '../../src/singleLine';

describe('processSingleLineCompletion', () => {
    describe('empty suffix', () => {
        it('inserts the whole completion when suffix is empty', () => {
            expect(processSingleLineCompletion('foo()', '')).toEqual({
                completionText: 'foo()',
                extraReplaceChars: 0,
            });
        });

        it('inserts empty completion when both are empty', () => {
            expect(processSingleLineCompletion('', '')).toEqual({
                completionText: '',
                extraReplaceChars: 0,
            });
        });
    });

    describe('exact match', () => {
        it('drops when suffix exactly equals completion', () => {
            expect(processSingleLineCompletion('foo', 'foo')).toEqual({
                completionText: '',
                extraReplaceChars: 0,
            });
        });

        it('drops with multi-word exact match', () => {
            expect(processSingleLineCompletion('foo bar', 'foo bar')).toEqual({
                completionText: '',
                extraReplaceChars: 0,
            });
        });
    });

    describe('completion adds before existing suffix', () => {
        // Model produced 'foo.bar' but the suffix already starts with 'foo',
        // so we need to replace the existing 'foo' with 'foo.bar' (insert .bar).
        it('replaces the existing prefix that matches the completion start', () => {
            expect(processSingleLineCompletion('foo.bar', 'foo')).toEqual({
                completionText: 'foo.bar',
                extraReplaceChars: 3,
            });
        });

        it('inserts prefix when completion starts with content not in suffix', () => {
            expect(processSingleLineCompletion('foo()', '()')).toEqual({
                completionText: 'foo',
                extraReplaceChars: 0,
            });
        });

        it('inserts just the new prefix when suffix is a substring of completion', () => {
            // Completion 'hello world' vs suffix 'world'. The diff starts with
            // 'hello ' (added) then 'world' (common). Pattern is '+=', starts
            // with '+' → take the added parts. Result: 'hello '.
            expect(processSingleLineCompletion('hello world', 'world')).toEqual({
                completionText: 'hello ',
                extraReplaceChars: 0,
            });
        });
    });

    describe('completion is a wholly different word', () => {
        it('inserts the new word and replaces all of the existing suffix', () => {
            expect(processSingleLineCompletion('hello', 'world')).toEqual({
                completionText: 'hello',
                extraReplaceChars: 5,
            });
        });
    });

    describe('completion overlaps with end of suffix', () => {
        // Suffix 'foobar', completion 'fooX' → diff pattern is "=+-" (foo is
        // common, X is new, bar is removed). The result replaces the whole
        // suffix with the new completion.
        it('replaces extended suffix when completion overlaps partially', () => {
            expect(processSingleLineCompletion('fooX', 'foobar')).toEqual({
                completionText: 'fooX',
                extraReplaceChars: 6,
            });
        });

        it('replaces suffix when completion overlaps at the start', () => {
            expect(processSingleLineCompletion('printX', 'print()')).toEqual({
                completionText: 'printX',
                extraReplaceChars: 7,
            });
        });
    });

    describe('unicode and whitespace edge cases', () => {
        it('handles trailing whitespace in completion', () => {
            expect(processSingleLineCompletion('foo ', '')).toEqual({
                completionText: 'foo ',
                extraReplaceChars: 0,
            });
        });

        it('handles numbers', () => {
            expect(processSingleLineCompletion('42', '')).toEqual({
                completionText: '42',
                extraReplaceChars: 0,
            });
        });

        it('handles multi-token completion', () => {
            // Model: 'foo bar', suffix: 'bar' → insert 'foo ' + keep 'bar' on the line.
            // Diff: "=foo bar" → common=bar, added=foo  → pattern is "+="? Let's
            // check: diffWordsWithSpace is sensitive to whitespace. The actual
            // behaviour: completion starts with content not in suffix, so the
            // '+' branch returns the added parts.
            const result = processSingleLineCompletion('foo bar', 'bar');
            expect(result.extraReplaceChars).toBe(0);
            expect(result.completionText).toContain('foo');
        });
    });
});
