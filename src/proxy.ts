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
  const authHeaders: Record<string, string> = config.upstreamApiKey
    ? { "Authorization": `Bearer ${config.upstreamApiKey}` }
    : {};

  const log = (msg: string) => {
    if (config.debug) {
      console.log(`[proxy] ${msg}`);
    }
  };

  /**
   * Forward a request to the upstream LLM API and stream the raw response
   * back to the caller. Used for non-meta-tool paths.
   */
  async function forwardAndPipe(
    path: string,
    body: unknown,
    res: ServerResponse
  ): Promise<void> {
    const url = `${upstream}${path}`;
    log(`-> ${url} (pipe)`);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(body),
    });
    const data = await response.text();
    res.writeHead(response.status, {
      "Content-Type": response.headers.get("content-type") ?? "application/json",
    });
    res.end(data);
  }

  /**
   * Forward a request to the upstream LLM API and parse the JSON response.
   * Used inside the meta-tool loop.
   */
  async function forwardForJson(
    path: string,
    body: unknown
  ): Promise<{ ok: boolean; status: number; body: string; json?: ChatCompletionResponse }> {
    const url = `${upstream}${path}`;
    log(`-> ${url}`);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, status: response.status, body: text };
    }
    try {
      return {
        ok: true,
        status: response.status,
        body: text,
        json: JSON.parse(text) as ChatCompletionResponse,
      };
    } catch {
      return { ok: false, status: 502, body: text };
    }
  }

  /** Safely parse tool_call arguments (model may send string or object). */
  function parseArgs(raw: string | undefined): Record<string, unknown> {
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  /**
   * Rewrite a `call_tool` tool_call into the real tool call it wraps.
   * Leaves other tool_calls untouched.
   */
  function unwrapCallTool(
    tc: NonNullable<ChatCompletionResponse["choices"][0]["message"]["tool_calls"]>[0]
  ): typeof tc {
    if (tc.function.name !== "call_tool") return tc;
    const parsed = parseArgs(tc.function.arguments);
    const realName = String(parsed.tool_name ?? "");
    if (!realName) return tc;
    const rawArgs = parsed.arguments;
    const argsStr =
      typeof rawArgs === "string"
        ? rawArgs
        : JSON.stringify(rawArgs ?? {});
    return {
      ...tc,
      function: { name: realName, arguments: argsStr },
    };
  }

  /**
   * Process a chat completion request with tool compression.
   *
   * Intercepts the search/call meta-tool loop so the caller only ever sees
   * real tool names it knows how to execute:
   *   - `search_tools` calls are resolved internally against the compressed
   *     registry and re-prompted to the model.
   *   - `call_tool` calls are rewritten to `{real_tool_name, real_args}` and
   *     returned to the caller for execution via its own tool runtime.
   *   - Real (passthrough) tool calls are returned unchanged.
   */
  async function handleChatCompletion(
    reqBody: ChatCompletionRequest,
    res: ServerResponse
  ): Promise<void> {
    const originalTools = reqBody.tools ?? [];

    // No tools? Pass through unchanged.
    if (originalTools.length === 0) {
      await forwardAndPipe("/chat/completions", reqBody, res);
      return;
    }

    // Build compressor. The execute stubs are never invoked here — we only
    // use the compressor for its search_tools logic and registry lookups.
    const toolEntries: ToolEntry[] = originalTools.map((spec) => ({
      spec,
      execute: async () => {
        throw new Error("proxy does not execute tools; caller does");
      },
    }));
    const compressor = new ToolCompressor(toolEntries, config);
    const stats = compressor.getStats();
    log(
      `Compressing ${stats.originalToolCount} tools -> ` +
        `${stats.compressedToolCount} (~${stats.estimatedTokenSavingsPercent}% savings)`
    );

    const compressedTools = compressor.getCompressedTools();
    const maxIters = config.maxLoopIterations ?? 10;
    // Copy messages so we can append without mutating the caller's array.
    const messages = [...reqBody.messages];

    for (let iter = 0; iter < maxIters; iter++) {
      const upstreamResult = await forwardForJson("/chat/completions", {
        ...reqBody,
        messages,
        tools: compressedTools,
      });

      if (!upstreamResult.ok || !upstreamResult.json) {
        res.writeHead(upstreamResult.status, {
          "Content-Type": "application/json",
        });
        res.end(upstreamResult.body);
        return;
      }

      const response = upstreamResult.json;
      const choice = response.choices?.[0];
      const toolCalls = choice?.message?.tool_calls ?? [];

      // No tool calls — model produced a final answer. Return as-is.
      if (toolCalls.length === 0) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
        return;
      }

      const searchCalls = toolCalls.filter(
        (tc) => tc.function.name === "search_tools"
      );

      // No search_tools this turn — rewrite any call_tool to the real tool
      // and hand the response to the caller. The caller knows how to run
      // real tools; it does not know search_tools/call_tool exist.
      if (searchCalls.length === 0) {
        const rewritten = toolCalls.map(unwrapCallTool);
        const finalResponse: ChatCompletionResponse = {
          ...response,
          choices: response.choices.map((c, i) =>
            i === 0
              ? {
                  ...c,
                  message: { ...c.message, tool_calls: rewritten },
                }
              : c
          ),
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(finalResponse));
        return;
      }

      // Has search_tools. Resolve them internally, append assistant turn and
      // tool results into the conversation, and re-prompt upstream.
      //
      // If the model also emitted call_tool / real tool calls in the same
      // turn, we intentionally omit them from the injected assistant message:
      // we have no results for them (the caller executes those), and the
      // OpenAI tool protocol requires a matching tool result for every
      // tool_call in an assistant message. The model will typically re-emit
      // the real calls on the next turn with search results in context.
      log(`Resolving ${searchCalls.length} search_tools call(s) internally`);
      messages.push({
        role: "assistant",
        content: choice?.message?.content ?? null,
        tool_calls: searchCalls,
      });
      for (const sc of searchCalls) {
        const args = parseArgs(sc.function.arguments);
        const result = await compressor.handleToolCall("search_tools", args);
        const payload = result.error
          ? { error: result.error }
          : result.result ?? {};
        messages.push({
          role: "tool",
          tool_call_id: sc.id,
          content: JSON.stringify(payload),
        });
      }
      // Loop: re-call upstream with search results injected.
    }

    log(`Max meta-tool loop iterations (${maxIters}) exceeded`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: `Proxy exceeded ${maxIters} internal meta-tool iterations`,
      })
    );
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
      const body = await readBody(req);
      const reqBody = JSON.parse(body) as ChatCompletionRequest;
      await handleChatCompletion(reqBody, res);
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
