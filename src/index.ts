/**
 * openclaw-tool-compressor
 *
 * Tool definition compression for OpenAI-compatible LLM APIs.
 * Replaces N tool definitions with 2 meta-tools (search_tools, call_tool),
 * reducing context window overhead by 70-97%.
 *
 * Two integration paths:
 *
 * 1. Library - import ToolCompressor and use directly in your agent code
 * 2. Proxy - drop-in HTTP proxy between agent and LLM API (also available via CLI)
 *
 * @example Library usage
 * ```typescript
 * import { ToolCompressor } from "openclaw-tool-compressor";
 *
 * const compressor = new ToolCompressor(myTools);
 * const compressed = compressor.getCompressedTools();
 * // Send compressed to LLM instead of myTools
 * // Handle responses with compressor.handleToolCall(name, args)
 * ```
 *
 * @example Proxy usage
 * ```typescript
 * import { createProxyServer } from "openclaw-tool-compressor";
 *
 * const proxy = createProxyServer({
 *   upstream: "http://localhost:1234/v1",
 *   port: 8100,
 *   debug: true,
 * });
 * proxy.start();
 * ```
 */

// Core compressor
export { ToolCompressor } from "./compressor.js";
export type { ToolEntry, ToolCallResult } from "./compressor.js";

// Registry (advanced usage)
export { ToolRegistry } from "./registry.js";

// Proxy server
export { createProxyServer } from "./proxy.js";
export type { ProxyConfig } from "./proxy.js";

// Meta-tool specs (for custom integrations)
export { SEARCH_TOOLS_SPEC, CALL_TOOL_SPEC } from "./meta-tools.js";

// Keyword utilities (for custom search implementations)
export { extractKeywords, expandWithSynonyms } from "./keywords.js";

// Types
export type {
  ToolDefinition,
  ToolParameterSchema,
  ToolExecuteFn,
  SearchResult,
  CompactListing,
  ToolCompressorConfig,
} from "./types.js";
