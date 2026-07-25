type Mode = 'always' | 'never' | 'auto';

/**
 * Decide whether to request a multi-line completion.
 *  - "always": respect the user's request
 *  - "never":  single line only
 *  - "auto":   single line when the cursor sits inside an expression
 *              (mid-line, after `.`/`->`/`=>`, after opening bracket, inside comment)
 */
export function shouldCompleteMultiline(
    prefix: string,
    suffix: string,
    mode: Mode,
): boolean {
    if (mode === 'always') return true;
    if (mode === 'never') return false;

    // Anything meaningful on the same line as the cursor → single line.
    // Trailing whitespace and trailing closing brackets/punctuation don't count
    // (cursor at end of `function foo() {` with `}` on the same line is still multi-line OK).
    const suffixOnSameLine = suffix.split('\n')[0] ?? '';
    const meaningful = suffixOnSameLine.replace(/[\s\)\]\};\],]+$/, '');
    if (meaningful.length > 0) return false;

    // After `.`, `->`, `=>` → property/member access → single line.
    if (/(\.|->|=>)\s*$/.test(prefix)) return false;

    const lastLine = prefix.split('\n').pop() ?? '';
    const trimmed = lastLine.replace(/\s+$/, '');

    // A lone identifier is still being typed (for example a Go struct field).
    if (/^\s*[A-Za-z_][A-Za-z0-9_]*$/.test(lastLine)) return false;

    // Right after an opening bracket → single line (closing is on same line).
    const last = trimmed.charAt(trimmed.length - 1);
    if (last === '(' || last === '{' || last === '[') return false;

    return true;
}

/** Max tokens for a multi-line completion (vs single-line which uses full maxTokens). */
export function maxTokensForMultiline(maxTokens: number, multiline: boolean): number {
    // ponytail: single-line gets the full budget, multi-line caps to 4 lines worth
    // (~32 tokens/line of code ≈ 128). Bump when we see real multiline abuse.
    return multiline ? Math.min(maxTokens, 256) : maxTokens;
}