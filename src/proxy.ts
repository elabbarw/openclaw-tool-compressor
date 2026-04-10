/**
 * OpenAI-compatible proxy server.
 *
 * Sits between the agent runtime and the LLM API (LM Studio, OpenAI, etc).
 * Intercepts chat completion requests, compresses tool definitions, and
 * handles the search/call meta-tool loop internally before returning
 * the final response to the caller.
 *
 * This is the "drop-in" integration path: point your agent at this proxy
 * instead of the LLM directly. No agent code changes needed.
 *
 * Architecture:
 *   Agent -> Proxy (compress tools) -> LLM API
 *   Agent <- Proxy (handle meta-tools internally) <- LLM API
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { ToolCompressor, type ToolEntry } from "./compressor.js";
import type { ToolDefinition, ToolCompressorConfig } from "./types.js";

export interface ProxyConfig extends ToolCompressorConfig {
  /** Upstream LLM API URL (e.g., http://localhost:1234/v1 for LM Studio) */
  upstream: string;
  /** Port to listen on (default: 8100) */
  port?: number;
  /** Host to bind to (default: 127.0.0.1) */
  host?: string;
  /** API key to send to upstream as Bearer token (optional) */
  upstreamApiKey?: string;
  /** Max internal search/call loop iterations to prevent runaway (default: 10) */
  maxLoopIterations?: number;
}

interface ChatCompletionRequest {
  model: string;
  messages: Array<{
    role: string;
    content?: string | null;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
    name?: string;
  }>;
  tools?: ToolDefinition[];
  tool_choice?: unknown;
  stream?: boolean;
  [key: string]: unknown;
}

interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Create and start the compression proxy server.
 */
export function createProxyServer(config: ProxyConfig) {
  const port = config.port ?? 8100;
  const host = config.host ?? "127.0.0.1";
  const upstream = config.upstream.replace(/\/$/, "");
  const maxLoop = config.maxLoopIterations ?? 10;
  const authHeaders: Record<string, string> = config.upstreamApiKey
    ? { "Authorization": `Bearer ${config.upstreamApiKey}` }
    : {};

  const log = (msg: string) => {
    if (config.debug) {
      console.log(`[proxy] ${msg}`);
    }
  };

  /**
   * Forward a request to the upstream LLM API.
   */
  async function forwardToUpstream(
    path: string,
    body: unknown
  ): Promise<ChatCompletionResponse> {
    const url = `${upstream}${path}`;
    log(`-> ${url}`);

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Upstream ${response.status}: ${text.slice(0, 500)}`
      );
    }

    return response.json() as Promise<ChatCompletionResponse>;
  }

  /**
   * Process a chat completion request with tool compression.
   *
   * 1. Extract tool definitions from the request
   * 2. Build a ToolCompressor from them
   * 3. Replace tools[] with compressed meta-tools
   * 4. Forward to upstream
   * 5. If the model calls search_tools or call_tool, handle internally
   *    and re-prompt the model with results (loop)
   * 6. Return final response when model produces content or calls
   *    a non-meta tool
   */
  async function handleChatCompletion(
    reqBody: ChatCompletionRequest
  ): Promise<ChatCompletionResponse> {
    const originalTools = reqBody.tools ?? [];

    // No tools? Pass through unchanged
    if (originalTools.length === 0) {
      return forwardToUpstream("/chat/completions", reqBody);
    }

    // Build compressor from the original tool definitions
    // We create stub execute functions since the proxy doesn't have
    // access to the real tool implementations - it returns tool call
    // requests back to the caller
    const toolEntries: ToolEntry[] = originalTools.map((spec) => ({
      spec,
      execute: async () => {
        // This won't be called for non-meta tools
        // The proxy returns tool_calls back to the agent
        throw new Error("Direct execution not available in proxy mode");
      },
    }));

    const compressor = new ToolCompressor(toolEntries, config);
    const stats = compressor.getStats();
    log(
      `Compressing ${stats.originalToolCount} tools -> ` +
        `${stats.compressedToolCount} (~${stats.estimatedTokenSavingsPercent}% savings)`
    );

    // Replace tools with compressed meta-tools
    const compressedReq: ChatCompletionRequest = {
      ...reqBody,
      tools: compressor.getCompressedTools(),
      // Force the model to not auto-parallelize meta-tool calls
      // which can cause confusion
    };

    // Remove streaming for the internal loop (we'll stream the final response)
    const wantStream = compressedReq.stream;
    compressedReq.stream = false;

    let messages = [...compressedReq.messages];
    let iterations = 0;

    // Internal loop: handle meta-tool calls without round-tripping to agent
    while (iterations < maxLoop) {
      iterations++;

      const response = await forwardToUpstream("/chat/completions", {
        ...compressedReq,
        messages,
        stream: false,
      });

      const choice = response.choices?.[0];
      if (!choice) {
        return response;
      }

      const toolCalls = choice.message.tool_calls;

      // No tool calls? Model produced final content - return to agent
      if (!toolCalls || toolCalls.length === 0) {
        log(`Final response after ${iterations} iteration(s)`);
        return response;
      }

      // Check if ANY tool call is a non-meta tool (passthrough or unknown)
      const hasNonMetaCall = toolCalls.some(
        (tc) =>
          tc.function.name !== "search_tools" &&
          tc.function.name !== "call_tool"
      );

      if (hasNonMetaCall) {
        // Rewrite call_tool calls back to direct tool calls for the agent
        const rewrittenCalls = [];
        const metaResults: Array<{
          tool_call_id: string;
          result: unknown;
        }> = [];

        for (const tc of toolCalls) {
          if (tc.function.name === "call_tool") {
            // Rewrite call_tool -> direct tool call
            try {
              const args = JSON.parse(tc.function.arguments);
              rewrittenCalls.push({
                id: tc.id,
                type: "function" as const,
                function: {
                  name: String(args.tool_name),
                  arguments: JSON.stringify(args.arguments ?? {}),
                },
              });
            } catch {
              rewrittenCalls.push(tc);
            }
          } else if (tc.function.name === "search_tools") {
            // Handle search internally, add result to messages
            let args: Record<string, unknown>;
            try {
              args = JSON.parse(tc.function.arguments);
            } catch {
              args = {};
            }
            const searchResult = await compressor.handleToolCall(
              "search_tools",
              args
            );
            metaResults.push({
              tool_call_id: tc.id,
              result: searchResult.result ?? searchResult.error,
            });
          } else {
            // Non-meta tool - pass through
            rewrittenCalls.push(tc);
          }
        }

        // If we have search results to inject, add them to messages and continue
        if (metaResults.length > 0 && rewrittenCalls.length === 0) {
          messages.push({
            role: "assistant",
            tool_calls: toolCalls,
          });
          for (const mr of metaResults) {
            messages.push({
              role: "tool",
              tool_call_id: mr.tool_call_id,
              content: JSON.stringify(mr.result),
            });
          }
          continue;
        }

        // Return rewritten tool calls to the agent
        if (rewrittenCalls.length > 0) {
          response.choices[0].message.tool_calls = rewrittenCalls;
          log(`Returning ${rewrittenCalls.length} rewritten tool call(s)`);
          return response;
        }
      }

      // All tool calls are meta-tools - handle internally
      messages.push({
        role: "assistant",
        tool_calls: toolCalls,
      });

      for (const tc of toolCalls) {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = {};
        }

        const result = await compressor.handleToolCall(
          tc.function.name,
          args
        );

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(result.result ?? result.error ?? ""),
        });

        log(
          `  Handled ${tc.function.name} internally (iteration ${iterations})`
        );
      }
    }

    // Max iterations reached - return last state
    log(`WARNING: Max loop iterations (${maxLoop}) reached`);
    return forwardToUpstream("/chat/completions", {
      ...compressedReq,
      messages,
      stream: false,
    });
  }

  /**
   * Sanitize upstream response to standard OpenAI format.
   * Strips non-standard fields that can confuse agent frameworks.
   */
  function sanitizeResponse(resp: ChatCompletionResponse): ChatCompletionResponse {
    return {
      id: resp.id,
      object: resp.object,
      created: resp.created,
      model: resp.model,
      choices: resp.choices.map((choice) => ({
        index: choice.index,
        message: {
          role: choice.message.role,
          ...(choice.message.content != null ? { content: choice.message.content } : {}),
          ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls } : {}),
        },
        finish_reason: choice.finish_reason,
      })),
      ...(resp.usage ? {
        usage: {
          prompt_tokens: resp.usage.prompt_tokens,
          completion_tokens: resp.usage.completion_tokens,
          total_tokens: resp.usage.total_tokens,
        },
      } : {}),
    };
  }

  /**
   * HTTP request handler
   */
  async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    // Health check
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // Models passthrough (with response size limit)
    if (req.method === "GET" && req.url === "/v1/models") {
      try {
        const upstreamRes = await fetch(`${upstream}/v1/models`, {
          headers: authHeaders,
        });
        const data = await upstreamRes.text();
        // Guard against oversized upstream responses
        if (data.length > 10 * 1024 * 1024) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Upstream response too large" }));
          return;
        }
        res.writeHead(upstreamRes.status, {
          "Content-Type": "application/json",
        });
        res.end(data);
      } catch (err) {
        log(`Models passthrough error: ${err}`);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to reach upstream" }));
      }
      return;
    }

    // Chat completions - the main event
    if (
      req.method === "POST" &&
      (req.url === "/v1/chat/completions" ||
        req.url === "/chat/completions")
    ) {
      try {
        const body = await readBody(req);
        const reqBody = JSON.parse(body) as ChatCompletionRequest;

        const result = await handleChatCompletion(reqBody);

        // Sanitize response to standard OpenAI format.
        // LM Studio adds non-standard fields (reasoning_content, stats,
        // system_fingerprint, completion_tokens_details) that can confuse
        // agent frameworks like OpenClaw.
        const sanitized = sanitizeResponse(result);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(sanitized));
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        log(`ERROR: ${message}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
      return;
    }

    // Reject unknown paths — only proxy known OpenAI-compatible endpoints
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  // Create server
  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error("[proxy] Unhandled error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal proxy error" }));
      }
    });
  });

  return {
    start: () => {
      server.listen(port, host, () => {
        console.log(`[tool-compressor] Proxy listening on ${host}:${port}`);
        console.log(`[tool-compressor] Upstream: ${upstream}`);
      });
      return server;
    },
    stop: () => {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
    server,
  };
}

/** Read full request body with size limit (default 10MB) */
function readBody(req: IncomingMessage, maxBytes = 10 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        req.destroy(new Error("Request body too large"));
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}
