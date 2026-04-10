import { describe, it, expect } from "vitest";
import { ToolCompressor, type ToolEntry } from "./compressor.js";
import type { ToolDefinition } from "./types.js";

/** Helper: create a mock tool entry */
function mockTool(name: string, description: string, returnValue: unknown = "ok"): ToolEntry {
  const spec: ToolDefinition = {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties: {
          input: { type: "string", description: "Input parameter" },
        },
        required: ["input"],
      },
    },
  };
  return {
    spec,
    execute: async (args) => ({ tool: name, args, result: returnValue }),
  };
}

/** Create a realistic set of MCP tools */
function mockMcpTools(): ToolEntry[] {
  return [
    mockTool("jira_create_issue", "Create a new Jira issue in a project"),
    mockTool("jira_search", "Search Jira issues using JQL query language"),
    mockTool("jira_get_issue", "Get a Jira issue by its key"),
    mockTool("jira_update_issue", "Update fields on a Jira issue"),
    mockTool("jira_transition_issue", "Transition a Jira issue to a new status"),
    mockTool("jira_add_comment", "Add a comment to a Jira issue"),
    mockTool("confluence_create_page", "Create a new Confluence wiki page"),
    mockTool("confluence_search", "Search Confluence content by query"),
    mockTool("confluence_get_page", "Get a Confluence page by ID"),
    mockTool("confluence_update_page", "Update an existing Confluence page"),
    mockTool("gitlab_create_issue", "Create a new GitLab issue"),
    mockTool("gitlab_create_merge_request", "Create a new GitLab merge request"),
    mockTool("gitlab_get_merge_request", "Get merge request details"),
    mockTool("gitlab_list_pipelines", "List CI/CD pipelines for a project"),
    mockTool("gitlab_get_file_contents", "Get file contents from a repository"),
    mockTool("n8n_list_workflows", "List all N8N automation workflows"),
    mockTool("n8n_get_workflow", "Get an N8N workflow by ID"),
    mockTool("n8n_activate_workflow", "Activate an N8N workflow"),
    mockTool("n8n_list_executions", "List workflow execution history"),
    mockTool("web_search", "Search the web for information"),
    mockTool("read_file", "Read a file from the filesystem"),
    mockTool("write_file", "Write content to a file"),
    mockTool("exec_command", "Execute a shell command"),
    mockTool("browser_navigate", "Navigate to a URL in the browser"),
    mockTool("send_email", "Send an email message"),
  ];
}

describe("ToolCompressor", () => {
  describe("getCompressedTools", () => {
    it("should replace N tools with 2 meta-tools", () => {
      const tools = mockMcpTools();
      const compressor = new ToolCompressor(tools);
      const compressed = compressor.getCompressedTools();

      expect(compressed).toHaveLength(2);
      expect(compressed[0].function.name).toBe("search_tools");
      expect(compressed[1].function.name).toBe("call_tool");
    });

    it("should include passthrough tools uncompressed", () => {
      const tools = mockMcpTools();
      const compressor = new ToolCompressor(tools, {
        passthrough: ["exec_command", "read_file"],
      });
      const compressed = compressor.getCompressedTools();

      // 2 meta-tools + 2 passthrough
      expect(compressed).toHaveLength(4);
      expect(compressed.map((t) => t.function.name)).toContain("exec_command");
      expect(compressed.map((t) => t.function.name)).toContain("read_file");
    });
  });

  describe("getStats", () => {
    it("should report correct compression stats", () => {
      const tools = mockMcpTools(); // 25 tools
      const compressor = new ToolCompressor(tools);
      const stats = compressor.getStats();

      expect(stats.originalToolCount).toBe(25);
      expect(stats.compressedToolCount).toBe(2);
      expect(stats.estimatedTokenSavingsPercent).toBeGreaterThan(90);
    });
  });

  describe("handleToolCall - search_tools", () => {
    it("should find jira tools when searching 'jira create ticket'", async () => {
      const compressor = new ToolCompressor(mockMcpTools());
      const result = await compressor.handleToolCall("search_tools", {
        query: "jira create ticket",
      });

      expect(result.handled).toBe(true);
      expect(result.error).toBeUndefined();

      const data = result.result as { tools: Array<{ name: string }>; matchCount: number };
      expect(data.matchCount).toBeGreaterThan(0);

      // jira_create_issue should be the top result
      expect(data.tools[0].name).toBe("jira_create_issue");
    });

    it("should find gitlab merge request tools when searching 'PR'", async () => {
      const compressor = new ToolCompressor(mockMcpTools());
      const result = await compressor.handleToolCall("search_tools", {
        query: "PR review",
      });

      expect(result.handled).toBe(true);
      const data = result.result as { tools: Array<{ name: string }> };

      // Should find merge request tools via synonym expansion
      const toolNames = data.tools.map((t) => t.name);
      expect(toolNames).toContain("gitlab_create_merge_request");
    });

    it("should find confluence tools when searching 'doc page'", async () => {
      const compressor = new ToolCompressor(mockMcpTools());
      const result = await compressor.handleToolCall("search_tools", {
        query: "doc page create",
      });

      expect(result.handled).toBe(true);
      const data = result.result as { tools: Array<{ name: string }> };
      const toolNames = data.tools.map((t) => t.name);
      expect(toolNames).toContain("confluence_create_page");
    });

    it("should return compact listing when no matches", async () => {
      const compressor = new ToolCompressor(mockMcpTools());
      const result = await compressor.handleToolCall("search_tools", {
        query: "xyznonexistent",
      });

      expect(result.handled).toBe(true);
      const data = result.result as { message: string; availableTools: unknown[] };
      expect(data.message).toContain("No tools matched");
      expect(data.availableTools.length).toBe(25);
    });

    it("should error on empty query", async () => {
      const compressor = new ToolCompressor(mockMcpTools());
      const result = await compressor.handleToolCall("search_tools", {
        query: "",
      });

      expect(result.handled).toBe(true);
      expect(result.error).toBeDefined();
    });
  });

  describe("handleToolCall - call_tool", () => {
    it("should execute a known tool and return result", async () => {
      const compressor = new ToolCompressor(mockMcpTools());
      const result = await compressor.handleToolCall("call_tool", {
        tool_name: "jira_create_issue",
        arguments: { input: "test" },
      });

      expect(result.handled).toBe(true);
      expect(result.error).toBeUndefined();

      const data = result.result as { tool: string; args: unknown; result: string };
      expect(data.tool).toBe("jira_create_issue");
      expect(data.result).toBe("ok");
    });

    it("should return helpful error for unknown tool", async () => {
      const compressor = new ToolCompressor(mockMcpTools());
      const result = await compressor.handleToolCall("call_tool", {
        tool_name: "nonexistent_tool",
        arguments: {},
      });

      expect(result.handled).toBe(true);
      expect(result.error).toContain("not found");
      expect(result.error).toContain("search_tools");
    });

    it("should error on missing tool_name", async () => {
      const compressor = new ToolCompressor(mockMcpTools());
      const result = await compressor.handleToolCall("call_tool", {
        arguments: {},
      });

      expect(result.handled).toBe(true);
      expect(result.error).toBeDefined();
    });

    it("should handle tool execution errors gracefully", async () => {
      const failingTool: ToolEntry = {
        spec: {
          type: "function",
          function: {
            name: "failing_tool",
            description: "A tool that always fails",
            parameters: { type: "object", properties: {} },
          },
        },
        execute: async () => {
          throw new Error("Connection timeout");
        },
      };

      const compressor = new ToolCompressor([failingTool]);
      const result = await compressor.handleToolCall("call_tool", {
        tool_name: "failing_tool",
        arguments: {},
      });

      expect(result.handled).toBe(true);
      expect(result.error).toContain("Connection timeout");
    });
  });

  describe("handleToolCall - non-meta tools", () => {
    it("should return handled=false for unknown tool names", async () => {
      const compressor = new ToolCompressor(mockMcpTools());
      const result = await compressor.handleToolCall("exec_command", {
        command: "ls",
      });

      expect(result.handled).toBe(false);
    });
  });
});
