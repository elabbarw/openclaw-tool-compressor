# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Node.js library + HTTP proxy that compresses an LLM API request's `tools[]` array down to two meta-tools (`search_tools`, `call_tool`). The model discovers tools on demand via search instead of seeing every schema in every prompt. Distributed as `openclaw-tool-compressor` on npm and runnable via `npx` as a drop-in OpenAI-compatible proxy.

## Commands

```bash
npm test                          # run all tests (vitest, ~700ms)
npx vitest run -t "should find jira tools"  # run one test by name pattern
npx vitest src/compressor.test.ts # run one file
npm run check                     # tsc --noEmit (typecheck only)
npm run build                     # tsc (writes dist/)
npm start                         # node dist/cli.js (after build)
```

`prepublishOnly` runs `check` → `test` → `build`. Trust it; don't `npm publish` without it.

The `package.json` uses a `"files"` whitelist (`dist/`, `LICENSE`, `README.md`). Do not add source files, `.full-review/`, `.claude/`, or test files to that list — they are intentionally excluded from the npm package because internal review docs would otherwise leak publicly.

## Architecture

Two integration modes share the same core (`src/compressor.ts` → `src/registry.ts`).

**Library mode.** Consumer constructs `new ToolCompressor(toolEntries, config)`, sends `compressor.getCompressedTools()` to the LLM, and routes responses via `compressor.handleToolCall(name, args)`. The compressor returns `{handled: true, result}` for meta-tools (`search_tools` / `call_tool`) and `{handled: false}` for everything else (caller handles it themselves).

**Proxy mode.** `src/proxy.ts` wraps the same compressor in an HTTP server. The hot loop is `handleChatCompletion` → `runUpstreamIteration`. The proxy:
1. Builds (or fetches from LRU) a compressor for the request's `tools[]`.
2. Replaces `tools[]` with the two meta-tool specs and forwards to upstream.
3. If the model emits `search_tools`, resolves it internally against the registry and re-prompts upstream — the caller (e.g. OpenClaw) never sees `search_tools`.
4. If the model emits `call_tool`, `unwrapCallTool` rewrites `assistant.tool_calls` to the real tool name + args before returning to the caller, so the caller's tool runtime sees a normal tool call.

The proxy never executes tools — execute stubs in `getCompressor` throw on purpose. Tool execution is the caller's job.

### Three load-bearing invariants

1. **Compressor and registry must be immutable after construction.** The proxy LRU cache (`LruCache` + `compressorCacheKey` in `src/proxy.ts`) shares instances across requests. Adding mutable per-request state to `ToolCompressor` or `ToolRegistry` would silently leak across requests in proxy mode. The header comments in both files document this — read them before adding fields.

2. **Compression is bypassed in three cases.** `handleChatCompletion` short-circuits to `forwardAndPipe` when (a) `tools[]` is empty, (b) `tool_choice` pins a specific function name (compression would hide it), or (c) tool count < `minToolCountForCompression` (default 8 — fixed cost outweighs savings on small sets). Don't break these guards when refactoring.

3. **The streaming SSE path has three modes.** `runUpstreamIteration` starts in `detect` mode and switches to either `pipe` (content streamed straight through to caller) or `buffer` (full response assembled because we need to inspect/rewrite tool_calls). Once mode commits to `pipe`, you cannot rewrite — held SSE lines are flushed as-is and a late tool_call would leak unrewritten. The defensive log at the bottom of `processLine` is intentional. Be very careful editing this state machine.

### Meta-tool name normalisation

`registry.ts:resolveName` promotes the first single underscore to a double underscore to handle MCP-style names where the model dropped one (`server_tool` → `server__tool`). Both `compressor.handleCall` and proxy's `unwrapCallTool` call this — keep them in sync if extending.

### Search

`extractKeywords` (in `src/keywords.ts`) is called once at registration. Scoring weights live in `registry.ts:search` (exact name match +10, name token +3, keyword +2, substring +1). `nameTokens` and `keywordSet` are precomputed on each `RegistryEntry` to keep search allocation-free.

`DEFAULT_PASSTHROUGH = ["exec", "read", "write", "edit", "apply_patch", "bash"]` — these tool names are sent uncompressed alongside the meta-tools. Override via `config.passthrough`.

## Test coverage gap to be aware of

Only `src/compressor.test.ts` exists — `src/proxy.ts` has zero tests despite being the largest file and most of the complexity. New work in `proxy.ts` (cache, bypass guards, meta-loop, SSE state machine) is not regression-protected. If you change non-trivial proxy behaviour, add a `src/proxy.test.ts` with a mock upstream `http.createServer` rather than relying on the existing compressor unit tests.

## Versioning

Patch bump for fixes only. **Behavioural changes to `handleToolCall` return shapes, meta-tool schemas, or the proxy's request/response contract are breaking** — they ride a minor bump (we are pre-1.0). The `0.3.0` release trimmed the `search_tools` response from `{tools, matchCount, totalAvailable, hint}` to `{tools}`; that's the kind of change that requires a minor bump and a CHANGELOG entry in the README.
