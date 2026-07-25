/** Strip junk from a raw completion: blank, repetition, markdown, line-above rewrites. */
export function postprocess(raw: string, prefix: string): string | undefined {
    let s = raw;

    // Strip leading/trailing whitespace.
    s = s.trim();
    if (s.length === 0) return undefined;

    // Remove markdown code fences (```lang\n ... ```).
    const openMatch = s.match(/^```[a-zA-Z0-9_-]*\n?/);
    if (openMatch) s = s.slice(openMatch[0].length);
    if (s.endsWith('```')) s = s.slice(0, -3).trimEnd();
    if (s.length === 0) return undefined;

    // Drop if it just rewrites the line above (model confused about cursor position).
    const lastLineAbove = prefix
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .slice(-1)[0];
    const firstLine = s.split('\n').find((l) => l.trim().length > 0);
    if (lastLineAbove && firstLine && lastLineAbove.trim() === firstLine.trim()) {
        return undefined;
    }

    // Drop if the completion is a repeating loop (>= 6 lines, same line 3+ times).
    if (isExtremeRepetition(s)) return undefined;

    return s;
}

function isExtremeRepetition(s: string): boolean {
    const lines = s.split('\n');
    if (lines.length < 6) return false;
    // Check first line vs line 1..3; if it appears in >=80% of subsequent lines, drop.
    for (let freq = 1; freq <= 3; freq++) {
        const probe = lines[freq];
        if (!probe || probe.length < 6) continue;
        const lcs = longestCommonSubstring(lines[0], probe);
        if (lcs.length < 6 && lcs.length / lines[0].length < 0.5) continue;
        let hits = 1;
        for (let i = freq; i < lines.length; i += freq) {
            if (lines[i].includes(lcs)) hits++;
        }
        if (hits / lines.length > 0.8) return true;
    }
    return false;
}

function longestCommonSubstring(a: string, b: string): string {
    if (a.length === 0 || b.length === 0) return '';
    let best = '';
    for (let i = 0; i < a.length; i++) {
        for (let j = i + 1; j <= a.length; j++) {
            const sub = a.slice(i, j);
            if (sub.length > best.length && b.includes(sub)) best = sub;
        }
    }
    return best;
}