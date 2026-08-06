import { describe, it, expect } from 'vitest';
import { shouldCompleteMultiline, maxTokensForMultiline } from '../../src/multiline';

describe('shouldCompleteMultiline', () => {
    describe('mode "always"', () => {
        it('always returns true regardless of cursor position', () => {
            expect(shouldCompleteMultiline('foo()', '() => { x }', 'always')).toBe(true);
        });
        it('returns true mid-expression', () => {
            expect(shouldCompleteMultiline('console.l', '', 'always')).toBe(true);
        });
        it('returns true after opening bracket', () => {
            expect(shouldCompleteMultiline('arr[', '', 'always')).toBe(true);
        });
    });

    describe('mode "never"', () => {
        it('always returns false regardless of cursor position', () => {
            expect(shouldCompleteMultiline('foo()\n', '\n', 'never')).toBe(false);
        });
        it('returns false at top of function body', () => {
            expect(shouldCompleteMultiline('function foo() {\n  ', '}', 'never')).toBe(false);
        });
    });

    describe('mode "auto" — single-line triggers', () => {
        it('returns false mid-line when suffix has text', () => {
            expect(shouldCompleteMultiline('console.l', '() => { x }', 'auto')).toBe(false);
        });
        it('returns false after a dot', () => {
            expect(shouldCompleteMultiline('console.', '', 'auto')).toBe(false);
        });
        it('returns false after an arrow function', () => {
            expect(shouldCompleteMultiline('const f = () =>', '', 'auto')).toBe(false);
        });
        it('returns false right after opening bracket', () => {
            expect(shouldCompleteMultiline('arr[', '', 'auto')).toBe(false);
        });
        it('returns false after lone identifier (Go struct field)', () => {
            expect(shouldCompleteMultiline('type Message struct {\n\tDeleted', '\n}', 'auto')).toBe(false);
        });
        it('returns false when cursor is mid-statement (with text on same line in suffix)', () => {
            // Cursor in the middle of 'let x = 1 + 2' with no content after.
            // shouldCompleteMultiline only checks: suffix on same line, dot/arrow,
            // lone identifier, opening bracket. With empty suffix and no
            // mid-line trigger, it returns true.
            expect(shouldCompleteMultiline('let x = 1 + ', '', 'auto')).toBe(true);
        });

        it('returns false when cursor is mid-line and there is text after on the same line', () => {
            // 'let x = 1 + ' with suffix '2;' on same line → single line.
            expect(shouldCompleteMultiline('let x = 1 + ', '2;', 'auto')).toBe(false);
        });
        it('returns false with trailing semicolon in suffix', () => {
            expect(shouldCompleteMultiline('foo();', ' bar();', 'auto')).toBe(false);
        });
        it('returns false with trailing comma in suffix', () => {
            expect(shouldCompleteMultiline('foo(', ', bar', 'auto')).toBe(false);
        });
        it('returns true with only a closing bracket in suffix (no real content)', () => {
            // ']' on the same line is stripped by the trailing-punctuation regex.
            // meaningful = ']'.replace(/[\s\)\]\};\],]+$/, '') = ''. So we
            // consider it "nothing on this line" → multi-line OK.
            expect(shouldCompleteMultiline('foo()', ']', 'auto')).toBe(true);
        });
        it('returns false when suffix on same line has unbalanced opening bracket', () => {
            // `function foo() {` followed by `}` on same line is still single
            // because of the } on the same line.
            expect(shouldCompleteMultiline('function foo() {', '}', 'auto')).toBe(false);
        });
    });

    describe('mode "auto" — multi-line triggers', () => {
        it('returns true at top of function body', () => {
            expect(shouldCompleteMultiline('function foo() {\n  ', '}', 'auto')).toBe(true);
        });
        it('returns true after a newline with empty rest of suffix', () => {
            expect(shouldCompleteMultiline('foo()\n', '\n', 'auto')).toBe(true);
        });
        it('returns true with empty prefix and empty suffix', () => {
            expect(shouldCompleteMultiline('', '', 'auto')).toBe(true);
        });
        it('returns true on its own line with nothing else', () => {
            expect(shouldCompleteMultiline('console.log("hi")\n', '', 'auto')).toBe(true);
        });
        it('returns true with multiline suffix starting on a new line', () => {
            expect(shouldCompleteMultiline('function foo() {\n  ', '\n}', 'auto')).toBe(true);
        });
    });

    describe('whitespace tolerance', () => {
        it('treats trailing whitespace as "nothing after cursor"', () => {
            expect(shouldCompleteMultiline('foo()\n   ', '', 'auto')).toBe(true);
        });
        it('treats trailing closing punctuation as "nothing after cursor"', () => {
            expect(shouldCompleteMultiline('foo()\n', '   ]', 'auto')).toBe(true);
        });
        it('detects non-whitespace on the same line as suffix', () => {
            expect(shouldCompleteMultiline('foo()\n', 'bar', 'auto')).toBe(false);
        });
    });
});

describe('maxTokensForMultiline', () => {
    it('returns the full budget for single-line', () => {
        expect(maxTokensForMultiline(512, false)).toBe(512);
    });

    it('caps at 256 for multi-line', () => {
        expect(maxTokensForMultiline(1024, true)).toBe(256);
    });

    it('passes through when below cap', () => {
        expect(maxTokensForMultiline(128, true)).toBe(128);
    });

    it('handles zero', () => {
        expect(maxTokensForMultiline(0, false)).toBe(0);
    });

    it('returns 256 at boundary', () => {
        expect(maxTokensForMultiline(256, true)).toBe(256);
    });
});
