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

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
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
  /**
   * Minimum tool count to enable compression (default: 8).
   *
   * Below this threshold, the proxy forwards the original tools[] unchanged.
   * Compression has a fixed cost (~500 tokens of meta-tool overhead plus
   * potential discovery round-trips), so on small tool sets it can be
   * net negative.
   */
  minToolCountForCompression?: number;
  /**
   * Max number of compressor instances to cache (default: 16).
   *
   * The compressor is keyed on a stable hash of `tools[]` plus the
   * compression-relevant config (synonyms, passthrough, maxResults,
   * minScore). For stable tool lists across a conversation, this skips
   * keyword extraction and registry construction on every request.
   */
  compressorCacheSize?: number;
}

/**
 * Tiny LRU built on the native Map (which preserves insertion order).
 * Sized small and bounded — intended for caching compressor instances
 * across requests that share the same tools[] payload.
 */
class LruCache<K, V> {
  private map = new Map<K, V>();
  constructor(private readonly max: number) {}
  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    // Refresh recency: delete + re-insert to move to tail.
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value as K | undefined;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);
  }
}

/**
 * Build a stable cache key for a compressor instance.
 *
 * We hash the normalised tool specs (sorted by name so insertion order
 * doesn't matter) together with the compression-relevant config. Anything
 * that changes how the registry behaves — synonyms, passthrough list,
 * scoring thresholds — must be part of the key; purely operational config
 * (upstream URL, debug, port) is not.
 */
function compressorCacheKey(
  tools: ToolDefinition[],
  config: ProxyConfig
): string {
  // SHA-1 is used here as a fast content-addressable fingerprint, not for
  // any cryptographic property. Collisions degrade to a cache miss, which
  // is harmless.
  const h = createHash("sha1");
  // Normalise tool specs to a stable canonical form.
  const specs = tools
    .map((t) => ({
      n: t.function.name,
      d: t.function.description ?? "",
      p: t.function.parameters ?? {},
    }))
    .sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : 0));
  // JSON.stringify can throw on adversarial input — circular refs introduced
  // by post-parse mutation, BigInt values, or rogue toJSON methods. Tools
  // come from the HTTP request body, which we don't control. Fall back to
  // a name-only key in that case so the request still gets a stable hash
  // (and stays out of the LRU rather than wedging the request with a 500).
  try {
    h.update(JSON.stringify(specs));
  } catch {
    h.update(specs.map((s) => s.n).join("\u0000"));
  }
  h.update("||");
  try {
    h.update(
      JSON.stringify({
        maxResults: config.maxResults ?? null,
        minScore: config.minScore ?? null,
        synonyms: config.synonyms ?? null,
        passthrough: config.passthrough
          ? [...config.passthrough].sort()
          : null,
      })
    );
  } catch {
    // Config is in-process; this should be unreachable. Empty marker on
    // the off chance someone stuffs a non-serialisable value in synonyms.
    h.update("config-unserialisable");
  }
  return h.digest("hex");
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
  const minToolsForCompression = config.minToolCountForCompression ?? 8;
  const compressorCache = new LruCache<string, ToolCompressor>(
    config.compressorCacheSize ?? 16
  );

  const log = (msg: string) => {
    if (config.debug) {
      console.log(`[proxy] ${msg}`);
    }
  };

  /**
   * Get (or build + cache) a ToolCompressor for the given tool list.
   * Execute stubs throw — the proxy never executes tools, only rewrites calls.
   */
  function getCompressor(tools: ToolDefinition[]): ToolCompressor {
    const key = compressorCacheKey(tools, config);
    const cached = compressorCache.get(key);
    if (cached) {
      log(`compressor cache HIT (${tools.length} tools)`);
      return cached;
    }
    log(`compressor cache MISS (${tools.length} tools)`);
    const entries: ToolEntry[] = tools.map((spec) => ({
      spec,
      execute: async () => {
        throw new Error("proxy does not execute tools; caller does");
      },
    }));
    const compressor = new ToolCompressor(entries, config);
    compressorCache.set(key, compressor);
    return compressor;
  }

  /**
   * Inspect `tool_choice` to see if the caller is forcing a specific tool.
   *
   * OpenAI's tool_choice can be:
   *   - "auto" / undefined / "required"  → model picks; compression is safe.
   *   - "none"                           → no tools used at all.
   *   - { type:"function", function:{ name:"X" } } → model must call X.
   *
   * If the caller pinned a specific function name, compression would hide
   * that tool from the model and the pinned choice would reference a name
   * the LLM doesn't have — better to pass the request through untouched.
   */
  function hasSpecificToolChoice(choice: unknown): boolean {
    if (!choice || typeof choice !== "object") return false;
    const obj = choice as Record<string, unknown>;
    const fn = obj.function as Record<string, unknown> | undefined;
    return typeof fn?.name === "string" && fn.name.length > 0;
  }

  /**
   * Forward a request to the upstream LLM API and pipe the response body
   * through to the caller chunk-by-chunk. Used for the no-tools passthrough
   * path so long streaming responses don't get buffered.
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

    res.writeHead(response.status, {
      "Content-Type": response.headers.get("content-type") ?? "application/json",
    });

    if (!response.body) {
      res.end();
      return;
    }

    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  }

  /**
   * Result of a single upstream iteration.
   * - "piped": content was streamed directly to the caller, nothing more to do.
   * - "buffered": full response assembled — caller decides whether to re-prompt
   *   (meta-tool loop) or emit to the client.
   * - "error": upstream failed.
   */
  type IterationResult =
    | { kind: "piped" }
    | { kind: "buffered"; response: ChatCompletionResponse }
    | { kind: "error"; status: number; body: string };

  /**
   * Run one upstream iteration.
   *
   * If `wantStream` is false, the upstream call is non-streaming and the full
   * JSON response is returned as `buffered`.
   *
   * If `wantStream` is true, the upstream call is streaming and the SSE is
   * parsed as it arrives. The first meaningful delta decides the mode:
   *   - delta contains tool_calls  → buffer the whole response (we need the
   *     full assembled tool_calls to detect search_tools / rewrite call_tool).
   *   - delta contains content     → start piping SSE directly to the caller
   *     (the long code-gen case — keeps the connection alive).
   *
   * When content starts piping, any SSE lines already consumed during the
   * detection phase are flushed to the caller first so no tokens are lost.
   */
  async function runUpstreamIteration(
    body: unknown,
    res: ServerResponse,
    wantStream: boolean
  ): Promise<IterationResult> {
    const url = `${upstream}/chat/completions`;
    log(`-> ${url}${wantStream ? " (stream)" : ""}`);

    const upstreamResp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(body),
    });

    if (!upstreamResp.ok) {
      const text = await upstreamResp.text();
      return { kind: "error", status: upstreamResp.status, body: text };
    }

    if (!wantStream) {
      const text = await upstreamResp.text();
      try {
        return {
          kind: "buffered",
          response: JSON.parse(text) as ChatCompletionResponse,
        };
      } catch {
        return { kind: "error", status: 502, body: text };
      }
    }

    // Some upstreams silently ignore `stream: true` and return a single JSON
    // blob with Content-Type: application/json. Detect that and fall back to
    // the non-streaming path so we don't mis-parse it as SSE.
    const upstreamCt = upstreamResp.headers.get("content-type") ?? "";
    if (
      upstreamCt.includes("application/json") &&
      !upstreamCt.includes("event-stream")
    ) {
      log("upstream ignored stream: true, falling back to JSON parse");
      const text = await upstreamResp.text();
      try {
        return {
          kind: "buffered",
          response: JSON.parse(text) as ChatCompletionResponse,
        };
      } catch {
        return { kind: "error", status: 502, body: text };
      }
    }

    if (!upstreamResp.body) {
      return { kind: "error", status: 502, body: "upstream returned no body" };
    }

    // Streaming path — parse SSE on the fly.
    const reader = upstreamResp.body.getReader();
    const decoder = new TextDecoder();
    let lineBuf = "";

    // Raw SSE lines held during the detect phase. If we switch to pipe mode
    // we flush these to the caller before streaming the rest.
    const heldLines: string[] = [];

    type Mode = "detect" | "pipe" | "buffer";
    let mode: Mode = "detect";
    let sseHeadersWritten = false;
    let doneSeen = false;

    // Running assembly of the full response (used in buffer mode).
    const assembled = {
      id: "",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "",
      role: "assistant",
      content: "",
      finishReason: "stop",
      toolCalls: [] as Array<{
        id?: string;
        type?: string;
        function: { name: string; arguments: string };
      }>,
    };

    const writeSseHeaders = () => {
      if (sseHeadersWritten) return;
      sseHeadersWritten = true;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
    };

    const flushHeldToPipe = () => {
      writeSseHeaders();
      for (const l of heldLines) res.write(l + "\n");
      heldLines.length = 0;
    };

    const mergeDelta = (chunk: Record<string, unknown>): void => {
      if (typeof chunk.id === "string") assembled.id = chunk.id;
      if (typeof chunk.model === "string") assembled.model = chunk.model;
      if (typeof chunk.created === "number") assembled.created = chunk.created;
      const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
      const ch0 = choices?.[0];
      if (!ch0) return;
      if (typeof ch0.finish_reason === "string") {
        assembled.finishReason = ch0.finish_reason;
      }
      const delta = ch0.delta as Record<string, unknown> | undefined;
      if (!delta) return;
      if (typeof delta.role === "string") assembled.role = delta.role;
      if (typeof delta.content === "string") assembled.content += delta.content;
      const tcArr = delta.tool_calls as
        | Array<{
            index?: number;
            id?: string;
            type?: string;
            function?: { name?: string; arguments?: string };
          }>
        | undefined;
      if (Array.isArray(tcArr)) {
        for (const tc of tcArr) {
          const idx =
            typeof tc.index === "number" ? tc.index : assembled.toolCalls.length;
          if (!assembled.toolCalls[idx]) {
            assembled.toolCalls[idx] = { function: { name: "", arguments: "" } };
          }
          const slot = assembled.toolCalls[idx];
          if (tc.id) slot.id = tc.id;
          if (tc.type) slot.type = tc.type;
          if (tc.function?.name) slot.function.name += tc.function.name;
          if (tc.function?.arguments) {
            slot.function.arguments += tc.function.arguments;
          }
        }
      }
    };

    const processLine = (rawLine: string): void => {
      const trimmed = rawLine.trimEnd();

      // Blank line = SSE event separator.
      if (trimmed === "") {
        if (mode === "pipe") res.write("\n");
        else heldLines.push(rawLine);
        return;
      }

      if (!trimmed.startsWith("data:")) {
        if (mode === "pipe") res.write(rawLine + "\n");
        else heldLines.push(rawLine);
        return;
      }

      const dataStr = trimmed.slice(5).trimStart();

      if (dataStr === "[DONE]") {
        doneSeen = true;
        if (mode === "pipe") res.write("data: [DONE]\n\n");
        return;
      }

      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(dataStr) as Record<string, unknown>;
      } catch {
        if (mode === "pipe") res.write(rawLine + "\n");
        else heldLines.push(rawLine);
        return;
      }

      mergeDelta(chunk);

      // Decide mode on the first delta that carries content or a tool name.
      if (mode === "detect") {
        const firstTcName = assembled.toolCalls[0]?.function.name;
        if (firstTcName) {
          mode = "buffer";
        } else if (assembled.content.length > 0) {
          mode = "pipe";
          flushHeldToPipe();
          res.write(rawLine + "\n");
          return;
        }
      }

      // Defensive: if a meta-tool call appears AFTER we committed to pipe
      // mode (model emitted content then called search_tools/call_tool in
      // the same turn), we can't rewrite in-place — we've already streamed
      // the earlier chunks. Log so this is visible; the caller will see a
      // tool_call it can't execute and surface its own error.
      if (mode === "pipe") {
        const leakedName = assembled.toolCalls[0]?.function.name;
        if (
          leakedName === "search_tools" ||
          leakedName === "call_tool"
        ) {
          log(
            `WARNING: meta-tool "${leakedName}" emitted after content in pipe ` +
              `mode — cannot rewrite; caller will see it unchanged`
          );
        }
      }

      if (mode === "pipe") {
        res.write(rawLine + "\n");
      } else {
        heldLines.push(rawLine);
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lineBuf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = lineBuf.indexOf("\n")) !== -1) {
          const line = lineBuf.slice(0, nl);
          lineBuf = lineBuf.slice(nl + 1);
          processLine(line);
        }
      }
      // Flush any trailing partial line.
      if (lineBuf.length > 0) processLine(lineBuf);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Upstream read error: ${msg}`);
      // If we've already started piping to the caller we can't change our
      // mind — close the SSE stream cleanly so the client sees a terminator
      // rather than a truncated connection.
      if ((mode as Mode) === "pipe") {
        if (!doneSeen) res.write("data: [DONE]\n\n");
        res.end();
        return { kind: "piped" };
      }
      return { kind: "error", status: 502, body: `upstream read error: ${msg}` };
    }

    if ((mode as Mode) === "pipe") {
      if (!doneSeen) res.write("data: [DONE]\n\n");
      res.end();
      return { kind: "piped" };
    }

    // Buffered or undecided (empty response) — assemble a ChatCompletionResponse.
    const message: ChatCompletionResponse["choices"][0]["message"] = {
      role: assembled.role,
      content: assembled.content.length > 0 ? assembled.content : null,
    };
    if (assembled.toolCalls.length > 0) {
      message.tool_calls = assembled.toolCalls.map((tc, i) => ({
        id: tc.id ?? `call_${i}`,
        type: (tc.type as "function") ?? "function",
        function: tc.function,
      }));
    }
    const full: ChatCompletionResponse = {
      id: assembled.id || `proxy-${Date.now()}`,
      object: "chat.completion",
      created: assembled.created,
      model: assembled.model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: assembled.finishReason,
        },
      ],
    };
    return { kind: "buffered", response: full };
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
   * Emit a final chat completion response to the caller in either plain JSON
   * or SSE (OpenAI streaming) format, depending on what the caller asked for.
   *
   * The meta-tool loop always runs against a non-streaming upstream because
   * it needs to inspect complete tool_calls. If the original caller requested
   * `stream: true`, we re-emit the final assembled response as a single SSE
   * chunk followed by `[DONE]`.
   */
  function sendFinal(
    res: ServerResponse,
    response: ChatCompletionResponse,
    wantStream: boolean
  ): void {
    if (!wantStream) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
      return;
    }

    const chunk = {
      id: response.id,
      object: "chat.completion.chunk",
      created: response.created,
      model: response.model,
      choices: response.choices.map((c) => ({
        index: c.index,
        delta: c.message,
        finish_reason: c.finish_reason,
        logprobs: null,
      })),
    };
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.end("data: [DONE]\n\n");
  }

  /**
   * Rewrite a `call_tool` tool_call into the real tool call it wraps.
   * Leaves other tool_calls untouched.
   *
   * Applies single→double underscore normalisation via `compressor` so that
   * `server_tool` (model dropped an underscore) resolves to the registered
   * `server__tool` before being handed to the caller.
   */
  function unwrapCallTool(
    tc: NonNullable<ChatCompletionResponse["choices"][0]["message"]["tool_calls"]>[0],
    compressor: ToolCompressor
  ): typeof tc {
    if (tc.function.name !== "call_tool") return tc;
    const parsed = parseArgs(tc.function.arguments);
    const rawName = String(parsed.tool_name ?? "");
    if (!rawName) return tc;
    const realName = compressor.resolveToolName(rawName) ?? rawName;
    if (realName !== rawName) {
      log(`Normalised tool name: ${rawName} -> ${realName}`);
    }
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

    // Caller pinned a specific tool (tool_choice.function.name=X). Compression
    // would hide that tool from the LLM. Bypass and pass through unchanged.
    if (hasSpecificToolChoice(reqBody.tool_choice)) {
      log("tool_choice pins a specific function, bypassing compression");
      await forwardAndPipe("/chat/completions", reqBody, res);
      return;
    }

    // Too few tools to benefit from compression. The fixed cost of the
    // meta-tool overhead + discovery round-trips outweighs the prompt
    // savings below this threshold.
    if (originalTools.length < minToolsForCompression) {
      log(
        `${originalTools.length} tools < minToolCountForCompression=` +
          `${minToolsForCompression}, bypassing compression`
      );
      await forwardAndPipe("/chat/completions", reqBody, res);
      return;
    }

    // Reuse cached compressor when tools[] and compression config match.
    const compressor = getCompressor(originalTools);
    const stats = compressor.getStats();
    log(
      `Compressing ${stats.originalToolCount} tools -> ` +
        `${stats.compressedToolCount} (~${stats.estimatedTokenSavingsPercent}% savings)`
    );

    const compressedTools = compressor.getCompressedTools();
    const maxIters = config.maxLoopIterations ?? 10;
    // Copy messages so we can append without mutating the caller's array.
    const messages = [...reqBody.messages];
    // Remember whether the caller wanted streaming. Upstream is always called
    // non-streaming inside the meta-loop; we re-emit SSE at the very end if
    // the original request had stream: true.
    const wantStream = reqBody.stream === true;

    for (let iter = 0; iter < maxIters; iter++) {
      const iterResult = await runUpstreamIteration(
        {
          ...reqBody,
          messages,
          tools: compressedTools,
          // Upstream streams only if the caller wanted streaming. When the
          // response is a content turn (e.g. long code generation), SSE is
          // piped directly from upstream to caller without buffering.
          stream: wantStream,
        },
        res,
        wantStream
      );

      if (iterResult.kind === "error") {
        if (!res.headersSent) {
          res.writeHead(iterResult.status, {
            "Content-Type": "application/json",
          });
        }
        res.end(iterResult.body);
        return;
      }

      // Content already streamed to the caller. Nothing more to do.
      if (iterResult.kind === "piped") {
        return;
      }

      const response = iterResult.response;
      const choice = response.choices?.[0];
      const toolCalls = choice?.message?.tool_calls ?? [];

      // No tool calls — model produced a final answer. Return as-is.
      if (toolCalls.length === 0) {
        sendFinal(res, response, wantStream);
        return;
      }

      const searchCalls = toolCalls.filter(
        (tc) => tc.function.name === "search_tools"
      );

      // No search_tools this turn — rewrite any call_tool to the real tool
      // and hand the response to the caller. The caller knows how to run
      // real tools; it does not know search_tools/call_tool exist.
      if (searchCalls.length === 0) {
        const rewritten = toolCalls.map((tc) => unwrapCallTool(tc, compressor));
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
        sendFinal(res, finalResponse, wantStream);
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

    // Max iterations reached. Don't forward the model's last (probably
    // still-looping) response — that would hand search_tools/call_tool back
    // to the caller, which has no handler for them. Instead synthesize a
    // clean stop message so the caller's agent loop can terminate gracefully.
    log(`WARNING: Max meta-tool loop iterations (${maxIters}) reached`);
    const stopResponse: ChatCompletionResponse = {
      id: `proxy-maxiter-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: String(reqBody.model ?? ""),
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              `Max tool iterations (${maxIters}) reached. ` +
              `Proceeding with available data.`,
          },
          finish_reason: "stop",
        },
      ],
    };
    sendFinal(res, stopResponse, wantStream);
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

    // Models passthrough (with response size limit).
    // Note: `upstream` already includes the /v1 path component (per CLI/README
    // convention: --upstream http://localhost:1234/v1), so we append /models
    // not /v1/models — same convention used for /chat/completions above.
    if (req.method === "GET" && req.url === "/v1/models") {
      try {
        const upstreamRes = await fetch(`${upstream}/models`, {
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
