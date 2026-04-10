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

Works the same in both proxy and library modes.

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

## License

MIT
