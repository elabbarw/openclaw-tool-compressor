/**
 * In-memory tool registry.
 *
 * Built per-request from the full tool definitions available to the agent.
 * Provides keyword search with scoring and compact fallback listing.
 *
 * Lifecycle: created at request start, garbage collected after response.
 * No persistence, no stale state, no cache invalidation headaches.
 */

import { extractKeywords, expandWithSynonyms } from "./keywords.js";
import type {
  ToolDefinition,
  RegistryEntry,
  ToolExecuteFn,
  SearchResult,
  CompactListing,
  ToolCompressorConfig,
} from "./types.js";

export class ToolRegistry {
  private entries: Map<string, RegistryEntry> = new Map();
  private config: Required<
    Pick<ToolCompressorConfig, "maxResults" | "minScore" | "synonyms">
  >;

  constructor(config?: ToolCompressorConfig) {
    this.config = {
      maxResults: config?.maxResults ?? 5,
      minScore: config?.minScore ?? 1,
      synonyms: config?.synonyms ?? {},
    };
  }

  /** Register a tool definition with its execute function */
  register(spec: ToolDefinition, execute: ToolExecuteFn): void {
    const name = spec.function.name;
    const description = spec.function.description ?? "";

    // Truncate description for compact listing
    const summary =
      description.length > 120
        ? description.slice(0, 117) + "..."
        : description;

    const keywords = extractKeywords(name, description);

    this.entries.set(name, {
      name,
      summary,
      fullSpec: spec,
      keywords,
      execute,
    });
  }

  /** Number of tools in the registry */
  get size(): number {
    return this.entries.size;
  }

  /** Check if a tool exists */
  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Get a tool's execute function */
  getExecute(name: string): ToolExecuteFn | undefined {
    return this.entries.get(name)?.execute;
  }

  /**
   * Search tools by keyword query.
   *
   * Scoring:
   *   - Exact tool name match: +10
   *   - Query token in tool name tokens: +3 per hit
   *   - Query token in keywords: +2 per hit
   *   - Substring match in tool name: +1 per hit
   *   - Server/prefix match: +1
   *
   * Returns top N matches with full specs, or compact listing if no matches.
   */
  search(query: string): SearchResult | CompactListing {
    // Tokenize and expand query
    const rawTokens = query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 0);

    const queryTokens = new Set(rawTokens);
    const expanded = expandWithSynonyms(queryTokens, this.config.synonyms);

    // Score each tool
    const scored: Array<{ name: string; score: number }> = [];

    for (const [name, entry] of this.entries) {
      let score = 0;

      // Exact name match (highest signal)
      if (expanded.has(name.toLowerCase())) {
        score += 10;
      }

      // Tool name token matching
      const nameTokens = new Set(
        name
          .toLowerCase()
          .replace(/[-_.]/g, " ")
          .split(/\s+/)
      );

      for (const token of expanded) {
        if (nameTokens.has(token)) {
          score += 3;
        }
      }

      // Keyword matching
      const kwSet = new Set(entry.keywords);
      for (const token of expanded) {
        if (kwSet.has(token)) {
          score += 2;
        }
      }

      // Substring matching on tool name
      const nameLower = name.toLowerCase();
      for (const token of expanded) {
        if (token.length > 2 && nameLower.includes(token)) {
          score += 1;
        }
      }

      if (score >= this.config.minScore) {
        scored.push({ name, score });
      }
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      // Fallback: return compact listing of all tool names
      return this.compactListing(query);
    }

    // Return top N with full specs
    const topN = scored.slice(0, this.config.maxResults);
    const matches = topN
      .map((s) => this.entries.get(s.name)?.fullSpec)
      .filter((spec): spec is ToolDefinition => spec !== undefined);

    return {
      matches,
      totalAvailable: this.entries.size,
    };
  }

  /** Compact listing of all tools (fallback for no-match) */
  private compactListing(query: string): CompactListing {
    const tools: Array<{ name: string; description: string }> = [];
    for (const [, entry] of this.entries) {
      tools.push({ name: entry.name, description: entry.summary });
    }
    // Sort alphabetically for scanability
    tools.sort((a, b) => a.name.localeCompare(b.name));

    return {
      message: `No tools matched "${query}". Here are all ${tools.length} available tools:`,
      availableTools: tools,
    };
  }
}
