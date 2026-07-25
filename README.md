# Dumb LLM Autocomplete

## Autocomplete, without the bullshit. For people who still remember how to type.

You know how to code. You've been doing it for years. You've got opinions about indentation and you don't need an AI to "help" you by rewriting your function from scratch, hallucinating a new dependency, or wrapping your three-line answer in a markdown code fence.

This is autocomplete for you.

Not a chatbot. Not a pair-programmer. Not an "agent." Just a fast, opinionated inline completion that fills in the next bit of code **at your cursor** and gets out of the way.

Ghost text appears. You hit `Tab`. You keep flowing.

That's it.

---

## Why it exists

Every modern editor now ships an "AI assistant" bolted on as a 200MB sidecar that wants to talk to you, explain things, and suggest refactors for code you wrote yesterday.

If that's your thing — great. It's not mine.

I wanted something simpler:

- **No chat.** No sidebar. No conversation history.
- **No waiting.** Suggestions show up as fast as you stop typing.
- **No nonsense.** No "Sure! Here's a function that..." Just code.
- **No lock-in.** Works with any OpenAI-compatible endpoint, OpenAI itself, local Ollama, LM Studio, llama.cpp, vLLM — whatever you already run.

If you still write code by hand and just want a slightly faster version of that, this is for you.

---

## What it does

- Streams inline ghost-text completions straight into VS Code.
- Speaks OpenAI-compatible API by default; one switch and it speaks native Ollama too.
- Picks the right "fill-in-the-middle" prompt template for the model you're running — Qwen, DeepSeek, StarCoder, CodeLlama — automatically.
- Trim...wait...trims messy model output: drops markdown fences, kills the "rewrites the line above" trick, stops at runaway repetition.
- Caches what you've already seen in SQLite, so re-asking is instant.
- Respects your `.env`, `.git/`, `node_modules/`, and `.vscode/` — no leaking secrets to a remote API.
- Stays out of the way. Cancels superseded requests so it never feels laggy.

---

## Who it's for

- Backend devs who type 120 wpm and don't want a chatbot interrupting.
- Engineers running local models on a workstation GPU who are tired of cloud-only tools.
- Anyone who's used Copilot, watched it confidently suggest the wrong API, and thought *"I could've finished this line by now."*
- People who pair-program with an LLM via a terminal and just want the same feeling inside their editor.

---

## Who it isn't for

- You want a conversational coding assistant. Use one — there are many, and several are great.
- You want the model to write whole files for you. This won't.
- You want an agent that runs tools. This won't.

---

## Getting started

1. Install the extension in VS Code.
2. Point it at a compatible endpoint — OpenAI, a local Ollama, LM Studio, vLLM, anything that speaks the OpenAI chat-completions protocol.
3. (Optional) Drop your API key into the secret store.
4. Start typing. Watch the ghost text. Hit `Tab` when it's right. Ignore it when it's not.

That's the entire onboarding doc.

---

## Principles

- **Less is more.** One feature, done well, beats ten features done poorly.
- **No telemetry.** Nothing leaves your machine except the request you actually make.
- **No surprises.** Whatever model you point it at, the prompt template is matched to that model. You can read the templates in `src/templates.ts`. It's a flat file. No magic.
- **You stay in charge.** Autocomplete, not autocode. It suggests. You decide.

---

## License

Pick one that fits your shop when you fork it. The code is small enough to read in an afternoon, which is the point.

---

*Built by someone who still believes the best code is the code you wrote yourself — just a little faster.*
