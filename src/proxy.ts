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
   * Forward a request to the upstream LLM API.
   */
  async function forwardToUpstream(
    path: string,
    body: unknown,
    res?: ServerResponse
  ): Promise<ChatCompletionResponse | null> {
    const url = `${upstream}${path}`;
    log(`-> ${url}`);

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(body),
    });

    // Pass through the upstream response as-is (including errors)
    if (res) {
      const data = await response.text();
      res.writeHead(response.status, {
        "Content-Type": response.headers.get("content-type") ?? "application/json",
      });
      res.end(data);
      return null;
    }

    return response.json() as Promise<ChatCompletionResponse>;
  }

  /**
   * Process a chat completion request with tool compression.
   *
   * Pure pass-through: compress the tools array, forward to upstream,
   * return the response unchanged. The agent handles the tool call loop.
   */
  async function handleChatCompletion(
    reqBody: ChatCompletionRequest,
    res: ServerResponse
  ): Promise<void> {
    const originalTools = reqBody.tools ?? [];

    // No tools? Pass through unchanged
    if (originalTools.length === 0) {
      await forwardToUpstream("/chat/completions", reqBody, res);
      return;
    }

    // Build compressor to get compressed tool list
    const toolEntries: ToolEntry[] = originalTools.map((spec) => ({
      spec,
      execute: async () => {
        throw new Error("Direct execution not available in proxy mode");
      },
    }));

    const compressor = new ToolCompressor(toolEntries, config);
    const stats = compressor.getStats();
    log(
      `Compressing ${stats.originalToolCount} tools -> ` +
        `${stats.compressedToolCount} (~${stats.estimatedTokenSavingsPercent}% savings)`
    );

    // Replace tools with compressed meta-tools, forward everything else unchanged
    await forwardToUpstream("/chat/completions", {
      ...reqBody,
      tools: compressor.getCompressedTools(),
    }, res);
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
