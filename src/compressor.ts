/**
 * ToolCompressor - the core module.
 *
 * Replaces N tool definitions with 2 meta-tools (search_tools, call_tool).
 * The model discovers tools on-demand via keyword search, then calls them
 * by name. Initial prompt cost drops from ~17k tokens to ~500 tokens.
 *
 * Usage:
 *   const compressor = new ToolCompressor(toolDefinitions, config);
 *   const compressedTools = compressor.getCompressedTools();
 *   // Pass compressedTools to the LLM instead of toolDefinitions
 *   // Handle meta-tool calls via compressor.handleToolCall()
 *
 * Lifecycle: per-request. Create fresh, discard after response.
 */

import { ToolRegistry } from "./registry.js";
import { SEARCH_TOOLS_SPEC, CALL_TOOL_SPEC } from "./meta-tools.js";
import type {
  ToolDefinition,
  ToolExecuteFn,
  ToolCompressorConfig,
  SearchResult,
  CompactListing,
} from "./types.js";

/** Input format: tool definition paired with its execute function */
export interface ToolEntry {
  spec: ToolDefinition;
  execute: ToolExecuteFn;
}

/** Result from handleToolCall */
export interface ToolCallResult {
  /** Whether this was a meta-tool call handled by the compressor */
  handled: boolean;
  /** The result to return to the model */
  result?: unknown;
  /** Error message if the call failed */
  error?: string;
}

/** Tools that are always passed through by default (core agent tools) */
const DEFAULT_PASSTHROUGH = ["exec", "read", "write", "edit", "apply_patch", "bash"];

export class ToolCompressor {
  private registry: ToolRegistry;
  private passthrough: Set<string>;
  private passthroughTools: ToolEntry[];
  private debug: boolean;

  constructor(tools: ToolEntry[], config?: ToolCompressorConfig) {
    this.registry = new ToolRegistry(config);
    this.passthrough = new Set(config?.passthrough ?? DEFAULT_PASSTHROUGH);
    this.passthroughTools = [];
    this.debug = config?.debug ?? false;

    for (const tool of tools) {
      const name = tool.spec.function.name;
      if (this.passthrough.has(name)) {
        // Passthrough tools are sent to the LLM uncompressed
        this.passthroughTools.push(tool);
        this.log(`Passthrough: ${name}`);
      } else {
        this.registry.register(tool.spec, tool.execute);
        this.log(`Registered: ${name}`);
      }
    }

    this.log(
      `Compressed ${this.registry.size} tools into 2 meta-tools` +
        (this.passthroughTools.length > 0
          ? ` + ${this.passthroughTools.length} passthrough`
          : "")
    );
  }

  /**
   * Get the compressed tool definitions to send to the LLM.
   *
   * Returns the 2 meta-tools + any passthrough tools.
   * This replaces the original tools[] array in the API call.
   */
  getCompressedTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = [SEARCH_TOOLS_SPEC, CALL_TOOL_SPEC];

    // Add passthrough tools uncompressed
    for (const pt of this.passthroughTools) {
      tools.push(pt.spec);
    }

    return tools;
  }

  /**
   * Handle a tool call from the model.
   *
   * If the call is for search_tools or call_tool, handle it internally
   * and return the result. If it's a passthrough tool, return handled=false
   * so the caller can route to the original handler.
   *
   * Returns:
   *   { handled: true, result: ... } - compressor handled it
   *   { handled: false } - not a meta-tool, caller should handle normally
   */
  async handleToolCall(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<ToolCallResult> {
    if (toolName === "search_tools") {
      return this.handleSearch(args);
    }

    if (toolName === "call_tool") {
      return this.handleCall(args);
    }

    // Not a meta-tool (could be a passthrough tool)
    return { handled: false };
  }

  /** Handle search_tools meta-tool */
  private handleSearch(
    args: Record<string, unknown>
  ): ToolCallResult {
    const query = String(args.query ?? "");
    if (!query.trim()) {
      return {
        handled: true,
        error: "search_tools requires a 'query' parameter",
      };
    }

    this.log(`search_tools: "${query}"`);
    const result = this.registry.search(query);

    if ("matches" in result) {
      // Found matches - return full specs
      const sr = result as SearchResult;
      this.log(
        `  Found ${sr.matches.length} matches (${sr.totalAvailable} total)`
      );
      return {
        handled: true,
        result: {
          tools: sr.matches.map((m) => m.function),
          matchCount: sr.matches.length,
          totalAvailable: sr.totalAvailable,
          hint:
            "Use call_tool with the exact tool name and arguments " +
            "from the schemas above.",
        },
      };
    } else {
      // No matches - return compact listing
      const cl = result as CompactListing;
      this.log(`  No matches, returning compact listing`);
      return {
        handled: true,
        result: cl,
      };
    }
  }

  /** Handle call_tool meta-tool */
  private async handleCall(
    args: Record<string, unknown>
  ): Promise<ToolCallResult> {
    const toolName = String(args.tool_name ?? "");
    // Handle case where model passes arguments as a JSON string instead of object
    let toolArgs: Record<string, unknown>;
    const rawArgs = args.arguments ?? {};
    if (typeof rawArgs === "string") {
      try {
        toolArgs = JSON.parse(rawArgs) as Record<string, unknown>;
      } catch {
        toolArgs = {};
      }
    } else {
      toolArgs = rawArgs as Record<string, unknown>;
    }

    if (!toolName) {
      return {
        handled: true,
        error: "call_tool requires a 'tool_name' parameter",
      };
    }

    if (!this.registry.has(toolName)) {
      // Tool not found - help the model recover
      const suggestion = toolName.includes("_")
        ? toolName.split("_").join(" ")
        : toolName;
      return {
        handled: true,
        error:
          `Tool "${toolName}" not found. ` +
          `Try: search_tools with query "${suggestion}" to find the right tool.`,
      };
    }

    this.log(`call_tool: ${toolName}(${JSON.stringify(toolArgs).slice(0, 100)})`);

    const execute = this.registry.getExecute(toolName);
    if (!execute) {
      return {
        handled: true,
        error: `Tool "${toolName}" has no execute function`,
      };
    }

    try {
      const result = await execute(toolArgs);
      this.log(`  call_tool ${toolName}: success`);
      return { handled: true, result };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      this.log(`  call_tool ${toolName}: error - ${message}`);
      return {
        handled: true,
        error: `Tool "${toolName}" failed: ${message}`,
      };
    }
  }

  /** Get token savings estimate */
  getStats(): {
    originalToolCount: number;
    compressedToolCount: number;
    estimatedTokenSavingsPercent: number;
  } {
    const original = this.registry.size + this.passthroughTools.length;
    const compressed = 2 + this.passthroughTools.length;
    // ~300 tokens per tool definition average, 2 meta-tools ~500 tokens
    const originalTokens = original * 300;
    const compressedTokens = 500 + this.passthroughTools.length * 300;
    const savings =
      originalTokens > 0
        ? Math.round(
            ((originalTokens - compressedTokens) / originalTokens) * 100
          )
        : 0;

    return {
      originalToolCount: original,
      compressedToolCount: compressed,
      estimatedTokenSavingsPercent: Math.max(0, savings),
    };
  }

  private log(msg: string): void {
    if (this.debug) {
      console.log(`[tool-compressor] ${msg}`);
    }
  }
}
