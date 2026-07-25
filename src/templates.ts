// ponytail: per-model prompt templates. Continue ships ~15 of these; we start with
// the FIM-family ones since those models actually understand FIM. Chat-template
// (the fallback) uses a `<CURSOR>` marker in a code block, which works for
// instruction-tuned models but is hit-or-miss with small base models.

export interface Template {
    /** If set, replaces the system prompt entirely. If undefined, the user's configured system prompt is used. */
    systemPrompt?: string;
    /** Build the user message from prefix/suffix. */
    userPrompt: (prefix: string, suffix: string, language: string) => string;
    /** Stop tokens passed to the API. Always stop at the FIM tokens so the model doesn't echo them back. */
    stop: string[];
}

const FIM_LANGUAGES_WITH_END = new Set([
    'python', 'ruby', 'perl', 'lua', 'haskell', 'elm', 'clojure',
    'erlang', 'ocaml', 'fsharp', 'lisp', 'scheme', 'tcl',
]);
// ponytail: languages without a sentinel end marker need a trailing newline appended
// to the suffix so the FIM model "sees" the closing of the current statement.

function maybeNewlineSuffix(suffix: string, lang: string): string {
    if (suffix.length === 0) return '\n';
    if (FIM_LANGUAGES_WITH_END.has(lang.toLowerCase())) return suffix;
    // ponytail: append (only if missing) a trailing newline so the FIM model
    // sees the current statement as closed; without this, languages like JS
    // tend to continue the previous line instead of producing a new completion.
    return suffix.endsWith('\n') ? suffix : suffix + '\n';
}

// https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B — FIM tokens are first-class
const qwenCoderFim: Template = {
    userPrompt: (prefix, suffix, lang) =>
        `<|fim_prefix|>${prefix}<|fim_suffix|>${maybeNewlineSuffix(suffix, lang)}<|fim_middle|>`,
    // ponytail: include chat-end tokens so small models that drift into prose
    // (e.g. "In this solution, we define...") get cut off cleanly.
    stop: ['<|fim_prefix|>', '<|fim_middle|>', '<|fim_suffix|>', '<|fim_pad|>', '<|repo_name|>', '<|file_sep|>', '<|endoftext|>', '<|im_start|>', '<|im_end|>'],
};

// https://huggingface.co/deepseek-ai/deepseek-coder — same convention
const deepseekCoderFim: Template = {
    userPrompt: (prefix, suffix) =>
        `<|fim▁begin|>${prefix}<|fim▁hole|>${suffix}<|fim▁end|>`,
    stop: ['<|fim▁begin|>', '<|fim▁hole|>', '<|fim▁end|>', '<|end▁of▁sentence|>'],
};

// https://huggingface.co/bigcode/starcoder — PSM (prefix-suffix-middle) style
const starcoderFim: Template = {
    userPrompt: (prefix, suffix) =>
        `<fim_prefix>${prefix}<fim_suffix>${suffix}<fim_middle>`,
    stop: ['<filename>', '<fim_suffix>', '<fim_prefix>', '<|endoftext|>', '</s>'],
};

// https://huggingface.co/codellama — similar to starcoder
const codellamaFim: Template = {
    userPrompt: (prefix, suffix) => `<PRE> ${prefix} <SUF> ${suffix} <MID>`,
    stop: ['<PRE>', '<SUF>', '<MID>', '<EOT>'],
};

// Fallback: chat-style `<CURSOR>` marker. Works for instruction-tuned models
// (gpt-4, claude, larger qwen, etc.) but bad for small base models.
const chatCursor: Template = {
    userPrompt: (prefix, suffix, lang) =>
        '```' + lang + '\n' + prefix + '<CURSOR>' + suffix + '\n```\n' +
        'Continue the code at the <CURSOR> marker. Output ONLY the code to insert at the cursor — no explanations, no markdown fences.',
    stop: [],
};

export function getTemplateForModel(model: string): Template {
    const m = model.toLowerCase();
    if (m.includes('qwen')) return qwenCoderFim;
    if (m.includes('deepseek')) return deepseekCoderFim;
    if (m.includes('starcoder') || m.includes('star-coder') || m.includes('starchat')) return starcoderFim;
    if (m.includes('codellama') || m.includes('code-llama')) return codellamaFim;
    return chatCursor;
}
