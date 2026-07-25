import { diffWordsWithSpace } from 'diff';

export interface SingleLineResult {
    completionText: string;
    /** Chars after cursor to replace. 0 = pure insert. */
    extraReplaceChars: number;
}

/**
 * When a single-line completion comes back, the model often overlaps with text
 * that already sits after the cursor. Detect that and return the right
 * `extraReplaceChars` so VS Code replaces the trailing text instead of inserting
 * a duplicate.
 *
 * Pattern (diffWordsWithSpace(suffix, completion)):
 *   "=" — common (in both)
 *   "+" — added (in completion only)
 *   "-" — removed (in suffix only)
 *
 *   suffix="",     completion="foo()"    → "+"         insert "foo()"
 *   suffix="()",   completion="foo()"    → "+="        insert "foo" (don't dup `()`)
 *   suffix="foo",  completion="foo.bar"  → "=+"        replace suffix with "foo.bar"
 *   suffix="bar",  completion="baz"     → "-+"        insert "baz"
 *   suffix="foo",  completion="foo"     → "="         drop (already there)
 *   suffix="foobar", completion="fooX"  → "=+-"       replace suffix with "fooX"
 */
export function processSingleLineCompletion(
    completionLine: string,
    lineSuffixText: string,
): SingleLineResult {
    if (lineSuffixText.length === 0) {
        return { completionText: completionLine, extraReplaceChars: 0 };
    }

    const diffs = diffWordsWithSpace(lineSuffixText, completionLine);
    const pattern = diffs.map((d) => (d.added ? '+' : d.removed ? '-' : '=')).join('');

    // Exact match → drop.
    if (pattern === '=') {
        return { completionText: '', extraReplaceChars: 0 };
    }

    // Starts with "+" → model added content first, possibly then echoed the suffix.
    // Take only the new (added) parts; don't replace anything.
    if (pattern[0] === '+') {
        const added = diffs.filter((d) => d.added).map((d) => d.value).join('');
        return { completionText: added, extraReplaceChars: 0 };
    }

    // Starts with "=" or "-" → model overlapped with or deleted the suffix.
    // Replace the existing suffix with the whole completion.
    return {
        completionText: completionLine,
        extraReplaceChars: lineSuffixText.length,
    };
}