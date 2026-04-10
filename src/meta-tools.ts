/**
 * Meta-tool definitions.
 *
 * These two tools replace the entire tools[] array in the LLM API call.
 * Combined token cost: ~500 tokens vs 5-17k+ for full tool specs.
 */

import type { ToolDefinition } from "./types.js";

/** search_tools - model calls this to discover available tools */
export const SEARCH_TOOLS_SPEC: ToolDefinition = {
  type: "function",
  function: {
    name: "search_tools",
    description:
      "Search available tools by keyword. Returns matching tools with their " +
      "full schemas so you can call them. If no match found, returns all " +
      "available tool names. Use this when you don't know the exact tool " +
      "name. If you already know the tool name, call call_tool directly.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Keywords to search tool names and descriptions " +
            "(e.g., 'email', 'jira create', 'file read', 'gitlab merge request')",
        },
      },
      required: ["query"],
    },
  },
};

/** call_tool - model calls this to execute a discovered tool */
export const CALL_TOOL_SPEC: ToolDefinition = {
  type: "function",
  function: {
    name: "call_tool",
    description:
      "Execute a tool by name. If you know the tool name and its arguments, " +
      "call it directly. Otherwise use search_tools first to discover " +
      "available tools and their schemas.",
    parameters: {
      type: "object",
      properties: {
        tool_name: {
          type: "string",
          description:
            "Exact name of the tool to call (from search_tools results)",
        },
        arguments: {
          type: "object" as const,
          description:
            "Arguments matching the tool's parameter schema",
        } as unknown as Record<string, unknown>,
      },
      required: ["tool_name", "arguments"],
    },
  },
};
