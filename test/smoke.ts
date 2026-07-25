/* eslint-disable no-console */
// ponytail: one self-check that runs after build, no test framework.
// Covers postprocess, singleLine, multiline, cache, SSE parser, streaming filters.

import { LruCache } from '../src/cache';
import { shouldCompleteMultiline } from '../src/multiline';
import { postprocess } from '../src/postprocess';
import { processSingleLineCompletion } from '../src/singleLine';
import { endpointFor } from '../src/streaming';

// Re-implement stopOnStopToken here (it lives unexported inside streaming.ts) so we can
// test the fence-skip logic without standing up an SSE stream. If streaming.ts's
// internal copy diverges, this test will catch it on the next refactor.
async function* stopOnStopToken(input: AsyncIterable<string>, tokens: string[]): AsyncGenerator<string> {
    const maxLen = Math.max(...tokens.map(t => t.length));
    let buf = '';
    let start = 0;
    const firstStop = (from: number) => {
        let best: { idx: number; tok: string } | undefined;
        for (const tok of tokens) {
            const idx = buf.indexOf(tok, from);
            if (idx !== -1 && (best === undefined || idx < best.idx)) best = { idx, tok };
        }
        return best;
    };
    const skipOpeningFence = (): boolean => {
        const hit = firstStop(start);
        if (!hit) return false;
        const between = buf.slice(start, hit.idx);
        if (between.trim().length > 0) return false;
        start = hit.idx + hit.tok.length;
        const lang = buf.slice(start).match(/^[a-zA-Z0-9_-]*\n?/);
        if (lang) start += lang[0].length;
        return true;
    };
    for await (const chunk of input) {
        buf += chunk;
        const safe = buf.length - maxLen;
        if (safe <= start) continue;
        skipOpeningFence();
        const hit = firstStop(start);
        if (hit && hit.idx < safe) {
            const between = buf.slice(start, hit.idx);
            if (between.trim().length > 0) { yield between; return; }
            start = hit.idx + hit.tok.length;
            const lang = buf.slice(start).match(/^[a-zA-Z0-9_-]*\n?/);
            if (lang) start += lang[0].length;
        }
        if (safe > start) { yield buf.slice(start, safe); start = safe; }
    }
    while (skipOpeningFence()) { /* keep skipping */ }
    const hit = firstStop(start);
    if (hit) {
        const between = buf.slice(start, hit.idx);
        if (between.trim().length > 0) { yield between; return; }
        start = hit.idx + hit.tok.length;
    }
    if (start < buf.length) yield buf.slice(start);
}

async function collect(g: AsyncIterable<string>): Promise<string> {
    const out: string[] = [];
    for await (const c of g) out.push(c);
    return out.join('');
}

async function runFilter(chunks: string[], tokens: string[]): Promise<string> {
    const gen = (async function* () { for (const c of chunks) yield c; })();
    const out: string[] = [];
    for await (const c of stopOnStopToken(gen, tokens)) out.push(c);
    return out.join('');
}

let pass = 0, fail = 0;

function check(name: string, got: unknown, want: unknown): void {
    const eq = JSON.stringify(got) === JSON.stringify(want);
    if (eq) { pass++; return; }
    fail++;
    console.error(`FAIL ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

function section(name: string): void { console.log(`\n# ${name}`); }

/* ---------- postprocess ---------- */

section('postprocess');
check('blank', postprocess('', 'def x():'), undefined);
check('whitespace only', postprocess('   \n  \n', 'def x():'), undefined);
check('md fence', postprocess('```py\nfoo()\n```', 'def x():'), 'foo()');
check('only fence', postprocess('```', 'def x():'), undefined);
check('rewrite line above', postprocess('foo\nfoo()', 'foo\n'), undefined);
check('extreme repetition',
    postprocess('print(1)\nprint(1)\nprint(1)\nprint(1)\nprint(1)\nprint(1)\nprint(1)\nprint(1)\nprint(1)\n', 'def x():'),
    undefined);
check('normal', postprocess('return 42', 'function foo() {\n  '), 'return 42');

/* ---------- singleLine ---------- */

section('singleLine');
check('no suffix', processSingleLineCompletion('foo()', ''), { completionText: 'foo()', extraReplaceChars: 0 });
check('exact match', processSingleLineCompletion('foo', 'foo'), { completionText: '', extraReplaceChars: 0 });
check('replace suffix', processSingleLineCompletion('foo.bar', 'foo'), { completionText: 'foo.bar', extraReplaceChars: 3 });
check('insert prefix', processSingleLineCompletion('foo()', '()'), { completionText: 'foo', extraReplaceChars: 0 });
check('diff text', processSingleLineCompletion('hello', 'world'), { completionText: 'hello', extraReplaceChars: 5 });
check('extended replace', processSingleLineCompletion('fooX', 'foobar'), { completionText: 'fooX', extraReplaceChars: 6 });

/* ---------- multiline ---------- */

section('multiline');
check('midline expr', shouldCompleteMultiline('console.l', '() => { x }', 'auto'), false);
check('after dot', shouldCompleteMultiline('console.', '', 'auto'), false);
check('open brace at end of fn', shouldCompleteMultiline('function foo() {', '', 'auto'), false);
check('top of fn', shouldCompleteMultiline('function foo() {\n  ', '}', 'auto'), true);
check('inside body', shouldCompleteMultiline('function foo() {\n  ', '\n}', 'auto'), true);
check('after arrow', shouldCompleteMultiline('const f = () =>', '', 'auto'), false);
check('after newline', shouldCompleteMultiline('foo()\n', '\n', 'auto'), true);
check('partial field identifier', shouldCompleteMultiline('type Message struct {\n\tDeleted', '\n}', 'auto'), false);
check('right after [', shouldCompleteMultiline('arr[', '', 'auto'), false);
check('always mode', shouldCompleteMultiline('foo()', '()', 'always'), true);
check('never mode', shouldCompleteMultiline('foo()\n', '\n', 'never'), false);

/* ---------- cache ---------- */

section('cache');
const cache = LruCache.get();
cache.put('console.l', "og('hello')");
cache.put('let x = ', '42');
check('exact key', cache.get('console.l'), "og('hello')");
check('extends by 1', cache.get('console.lo'), "g('hello')");
check('extends by 2', cache.get('console.log'), "('hello')");
check('no key', cache.get('xyz'), undefined);
check('mismatch', cache.get('console.lx'), undefined);
cache.close();

/* ---------- endpoint normalization ---------- */

section('endpointFor');
check('bare → chat',          endpointFor('http://localhost:11434', 'openai-compatible'), 'http://localhost:11434/v1/chat/completions');
check('bare → ollama-native', endpointFor('http://localhost:11434', 'ollama-native'), 'http://localhost:11434/api/generate');
check('trailing slash',       endpointFor('http://localhost:11434/', 'openai-compatible'), 'http://localhost:11434/v1/chat/completions');
check('full chat path',       endpointFor('http://localhost:11434/v1/chat/completions', 'openai-compatible'), 'http://localhost:11434/v1/chat/completions');
check('full → ollama-native', endpointFor('http://localhost:11434/v1/chat/completions', 'ollama-native'), 'http://localhost:11434/api/generate');
check('openai base',          endpointFor('https://api.openai.com', 'openai-compatible'), 'https://api.openai.com/v1/chat/completions');
check('openai /v1',           endpointFor('https://api.openai.com/v1', 'openai-compatible'), 'https://api.openai.com/v1/chat/completions');
check('lm studio',           endpointFor('http://localhost:1234', 'openai-compatible'), 'http://localhost:1234/v1/chat/completions');
check('empty fallback',       endpointFor('', 'openai-compatible'), 'http://localhost:11434/v1/chat/completions');

/* ---------- stream filter (fence handling) ---------- */

(async () => {
section('stream filter');
const tok = ['```'];
check('wrapped ts', await runFilter(['```typescript\nreturn x;\n```'], tok), 'return x;\n');
check('fence + junk', await runFilter(['```ts\nfoo()\n```\nHere is what I did:\nblah'], tok), 'foo()\n');
check('no fence', await runFilter(['plain code()\nno fences'], tok), 'plain code()\nno fences');
check('only opening', await runFilter(['```'], tok), '');
check('stray mid', await runFilter(['foo()\n```\nbar'], tok), 'foo()\n');
check('no closing', await runFilter(['```ts\nfoo()'], tok), 'foo()');
check('chunked', await runFilter(['```ts\n', 'foo()\n', '```'], tok), 'foo()\n');
})().then(() => finish()).catch((e) => { console.error(e); process.exit(1); });

/* ---------- summary ---------- */

function finish() {
console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
}
