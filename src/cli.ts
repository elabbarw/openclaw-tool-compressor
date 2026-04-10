#!/usr/bin/env node
/**
 * CLI entry point for the tool-compressor proxy.
 *
 * Usage:
 *   npx openclaw-tool-compressor --upstream http://localhost:1234/v1
 *   npx openclaw-tool-compressor --upstream http://localhost:1234/v1 --port 8100 --debug
 */

import { createProxyServer } from "./proxy.js";

function parseArgs(args: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--") && i + 1 < args.length) {
      const key = arg.slice(2);
      const value = args[i + 1];
      if (!value.startsWith("--")) {
        parsed[key] = value;
        i++;
      } else {
        parsed[key] = "true";
      }
    } else if (arg.startsWith("--")) {
      parsed[arg.slice(2)] = "true";
    }
  }
  return parsed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(`
openclaw-tool-compressor - Compression proxy for LLM tool definitions

Usage:
  openclaw-tool-compressor --upstream <url> [options]

Options:
  --upstream <url>    Upstream LLM API URL (required)
                      e.g., http://localhost:1234/v1 (LM Studio)
                           https://api.openai.com/v1 (OpenAI)
  --port <number>     Port to listen on (default: 8100)
  --host <addr>       Host to bind to (default: 127.0.0.1)
  --max-results <n>   Max search results to return (default: 5)
  --max-loop <n>      Max internal loop iterations (default: 10)
  --api-key <key>     API key to send to upstream as Bearer token
  --debug             Enable debug logging
  --help              Show this help message

Example:
  # Start proxy in front of LM Studio
  openclaw-tool-compressor --upstream http://localhost:1234/v1 --debug

  # Start proxy in front of OpenAI
  openclaw-tool-compressor --upstream https://api.openai.com/v1 --api-key sk-...

  # Then point your agent at http://localhost:8100/v1 instead
`);
    process.exit(0);
  }

  if (!args.upstream) {
    console.error("ERROR: --upstream is required");
    console.error(
      "Usage: openclaw-tool-compressor --upstream http://localhost:1234/v1"
    );
    process.exit(1);
  }

  const proxy = createProxyServer({
    upstream: args.upstream,
    port: args.port ? parseInt(args.port, 10) : 8100,
    host: args.host ?? "127.0.0.1",
    maxResults: args["max-results"]
      ? parseInt(args["max-results"], 10)
      : 5,
    maxLoopIterations: args["max-loop"]
      ? parseInt(args["max-loop"], 10)
      : 10,
    upstreamApiKey: args["api-key"] ?? undefined,
    debug: args.debug === "true",
  });

  proxy.start();

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n[tool-compressor] Shutting down...");
    proxy.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
