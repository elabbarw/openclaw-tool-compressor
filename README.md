# openclaw-tool-compressor

Tool definition compression for OpenAI-compatible LLM APIs. Replaces N tool definitions with 2 meta-tools (`search_tools`, `call_tool`), reducing context window overhead by 70-97%.

## The Problem

Every tool you give an LLM costs tokens. A typical tool definition is 200-400 tokens. Load 30+ MCP tools and you're burning 9,000-17,000+ tokens per request before the model reads any user content. This means slower responses, higher costs, and models struggling to pick the right tool from a crowded list.

## How It Works

Instead of sending all tool schemas to the model, the compressor sends just two:

1. **`search_tools`** - the model searches for tools by keyword, gets back full schemas for matching tools only
2. **`call_tool`** - the model calls a discovered tool by name with arguments

The model discovers what it needs on-demand. Everything else stays out of the context window.

```
Before: 50 tool schemas -> ~17,000 tokens per request
After:  2 meta-tools    -> ~500 tokens per request (97% reduction)
```

## Quick Start

### As a proxy (zero code changes)

Drop this between your agent and LM Studio / OpenAI / any OpenAI-compatible API:

```bash
npx openclaw-tool-compressor --upstream http://localhost:1234/v1 --debug
```

Then point your agent at `http://localhost:8100/v1` instead of the LLM directly. The proxy intercepts tool definitions, compresses them, and handles the search/call loop internally.

### As a library

```typescript
import { ToolCompressor } from "openclaw-tool-compressor";

// Your existing tool definitions
const tools = [
  {
    spec: { type: "function", function: { name: "jira_create_issue", ... } },
    execute: async (args) => { /* ... */ }
  },
  // ... 50 more tools
];

// Compress
const compressor = new ToolCompressor(tools);
const compressed = compressor.getCompressedTools();

// Send compressed tools to LLM instead of the full list
const response = await llm.chat({
  messages: [...],
  tools: compressed,
});

// Handle meta-tool calls
for (const toolCall of response.tool_calls) {
  const result = await compressor.handleToolCall(
    toolCall.function.name,
    JSON.parse(toolCall.function.arguments)
  );

  if (result.handled) {
    // Compressor handled it (search or call) - feed result back to model
    messages.push({ role: "tool", content: JSON.stringify(result.result) });
  } else {
    // Not a meta-tool (passthrough) - handle normally
  }
}
```

## Configuration

Shared options (proxy + library):

```typescript
{
  maxResults: 5,           // Max search results returned (default: 5)
  minScore: 1,             // Min keyword match score (default: 1)
  passthrough: ["exec"],   // Tools to send uncompressed (default: [])
  synonyms: {              // Custom synonym mappings
    "ticket": ["issue", "bug"],
  },
  debug: true,             // Log search/call activity (default: false)
}
```

### Proxy-only options

| Option | Default | Description |
|---|---|---|
| `port` | `8100` | Port to listen on |
| `host` | `127.0.0.1` | Bind address (see Security below) |
| `upstreamApiKey` | — | Bearer token forwarded upstream |
| `maxLoopIterations` | `10` | Max internal search/call iterations before stopping |
| `minToolCountForCompression` | `8` | Below this tool count, the request is forwarded unchanged. Compression has a fixed cost (~500 tokens of meta-tool overhead + discovery round-trips), so on small tool sets it can be net-negative. |
| `compressorCacheSize` | `16` | Max cached compressor instances (LRU). For stable tool lists across a conversation, this skips keyword extraction and registry construction on every request. |

The proxy also bypasses compression automatically when:

- The request has no `tools[]`.
- `tool_choice` pins a specific function name (compression would hide that tool from the model).
- The tool count is below `minToolCountForCompression`.

### Passthrough

Some tools should always be visible to the model without searching (e.g., `exec_command`, `read_file`). Add them to `passthrough` and they'll be included alongside the 2 meta-tools.

### Synonyms

The built-in synonym map handles common cases ("ticket" -> "issue", "PR" -> "merge_request", "doc" -> "confluence"). Add domain-specific mappings via the `synonyms` config.

## How Search Works

Keywords are auto-generated from tool names (split on underscores/hyphens) and descriptions. Scoring:

| Signal | Weight | Example |
|--------|--------|---------|
| Exact tool name match | +10 | query "web_search" matches tool "web_search" |
| Token in tool name | +3 | query "jira" matches "jira_create_issue" |
| Token in keywords | +2 | query "ticket" matches keyword "issue" (via synonyms) |
| Substring in name | +1 | query "merge" matches "create_merge_request" |

No-match fallback: returns a compact list of all tool names with one-line descriptions, so the model can self-correct and search again.

## Token Impact

| Tools loaded | Before | After | Savings |
|-------------|--------|-------|---------|
| 10 | ~3,000 tokens | ~500 tokens | 83% |
| 30 | ~9,000 tokens | ~500 tokens | 94% |
| 50+ | ~17,000+ tokens | ~500 tokens | 97% |

Search responses (when the model discovers tools) cost ~200-900 tokens depending on matches, but this is a one-time cost per conversation, not per message.

## Architecture

```
Without compression:
  Agent -> [50 tool schemas in every request] -> LLM

With proxy:
  Agent -> Proxy -> [2 meta-tools] -> LLM
                     |
                     +-- model calls search_tools -> proxy handles internally
                     +-- model calls call_tool -> proxy rewrites to direct call

With library:
  Agent code -> ToolCompressor -> [2 meta-tools + passthrough] -> LLM
                |
                +-- compressor.handleToolCall() routes search/call internally
                +-- passthrough tools -> visible without search
```

## Integration Modes

| Mode | Best For | How It Works |
|------|----------|--------------|
| **Proxy** | Any OpenAI-compatible setup | HTTP proxy between agent and LLM API. No code changes. |
| **Library** | Custom agent code | Import and use programmatically. Full control. |

## Security

The proxy binds to `127.0.0.1` by default — it is reachable only from the local machine. **It does not authenticate inbound requests.** If you bind to `0.0.0.0` or any non-loopback interface (common in containers and cloud deployments), the proxy is open to anyone on the network and any caller can use your `--api-key` for free upstream LLM calls. Run behind a firewall, reverse proxy, or in a network-isolated environment in those cases.

`--debug` writes search queries, tool names, and partial tool arguments to stdout. Don't enable it in shared or multi-tenant environments where logs may be visible to others.

## Changelog

### 0.3.4 — fix tool_calls being silently dropped + diagnostic logs

- **Fix (proxy):** When the assembled response contained `tool_calls` but the upstream's final SSE chunk didn't explicitly set `finish_reason: "tool_calls"` (some upstreams leave it null, some reasoning-model variants forget to override the default `"stop"`), the proxy was forwarding `finish_reason: "stop"` alongside the tool_calls. Strict callers treated the response as a final text answer and silently dropped the tool_calls. The proxy now overrides `finish_reason` to `"tool_calls"` whenever assembled tool_calls are present, regardless of what upstream said.
- **Debug:** `unwrapCallTool` now logs each rewrite (`call_tool -> real_tool_name`) and warns when `call_tool` arrives without a `tool_name`. Helps diagnose model-side malformations under context pressure.

### 0.3.3 — fix meta-tool leak when models emit reasoning before tool calls

- **Fix (proxy):** Models that emit content tokens before a tool call (Qwen3.5 reasoning, some MoE variants) caused the proxy's pipe-mode SSE to commit to streaming the reasoning text to the caller before the meta-tool call arrived. The meta-tool then leaked through unrewritten. Fixed by removing pipe mode entirely from the meta-loop — the upstream SSE is now always buffered before any decision is made about emitting to the caller.
- **Trade-off:** Callers with `stream: true` no longer receive incremental tokens for content responses. The full response is delivered as a single SSE chunk after upstream completes. To prevent HTTP timeouts on long responses (e.g. multi-minute code generation), SSE keepalive comments are emitted every 10s after a 5s grace.

### 0.3.2 — meta-loop context pruning

- **Perf (proxy):** Stale `search_tools` results are now stubbed out of `messages[]` between meta-loop iterations. Each search response carries 2-5K tokens of tool schemas, and prior versions replayed every prior round's results on every upstream call — quadratic prompt growth that could exhaust a 65K context window in 3-4 search rounds. Older results are replaced with `{"tools": []}` — same shape the model already knows how to read. The assistant `tool_call` envelope is left intact so the OpenAI `tool_call_id` pairing stays valid; the model can re-call `search_tools` if it needs the schemas back.

### 0.3.1 — bug fix

- **Fix (proxy):** `/v1/models` was forwarded to `{upstream}/v1/models`, producing a double `/v1/v1/...` path with the documented `--upstream http://localhost:1234/v1` convention. LM Studio silently rejected the request. Now forwards to `{upstream}/models`, consistent with `/chat/completions`.

### 0.3.0 — performance + correctness pass

- **Breaking:** `search_tools` response is now `{ tools }`. The previous `matchCount`, `totalAvailable`, and `hint` fields have been removed (saved ~20 tokens per search response, but library consumers that destructured those fields will silently get `undefined`).
- **New (proxy):** `minToolCountForCompression` (default `8`) — bypass compression on small tool sets.
- **New (proxy):** `compressorCacheSize` (default `16`) — LRU cache of compressor instances, keyed by tools[] + compression config. Removes per-request keyword extraction and registry construction when tool list is stable.
- **New (proxy):** Specific `tool_choice` (`{function:{name:"X"}}`) now bypasses compression — fixes a latent bug where compression would hide the pinned tool from the LLM.
- **Perf:** Precomputed name tokens / keyword sets on every registry entry — search no longer allocates Sets per entry per query.

## License

MIT
