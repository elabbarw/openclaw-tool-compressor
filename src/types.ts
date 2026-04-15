/**
 * Tool Compressor Types
 *
 * OpenAI-compatible tool definition format.
 */

/** OpenAI-compatible tool parameter schema */
export interface ToolParameterSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

/** OpenAI-compatible function tool definition */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: ToolParameterSchema;
  };
}

/** Internal registry entry for a compressed tool */
export interface RegistryEntry {
  /** Original tool name */
  name: string;
  /** Lowercased tool name (cached for case-insensitive matching) */
  nameLower: string;
  /** Tokens of the tool name, split on separators (cached for search scoring) */
  nameTokens: Set<string>;
  /** One-line description (truncated for compact listing) */
  summary: string;
  /** Full OpenAI tool definition (restored on search match) */
  fullSpec: ToolDefinition;
  /** Auto-generated search keywords */
  keywords: string[];
  /** Keywords as a Set (cached for search scoring) */
  keywordSet: Set<string>;
  /** Original execute function reference */
  execute: ToolExecuteFn;
}

/** Tool execute function signature */
export type ToolExecuteFn = (
  args: Record<string, unknown>
) => Promise<unknown>;

/** Search result returned to the model */
export interface SearchResult {
  matches: ToolDefinition[];
  totalAvailable: number;
}

/** Compact tool listing for no-match fallback */
export interface CompactListing {
  message: string;
  availableTools: Array<{ name: string; description: string }>;
}

/** Compressor configuration */
export interface ToolCompressorConfig {
  /** Max search results to return (default: 5) */
  maxResults?: number;
  /** Min keyword match score to qualify (default: 1) */
  minScore?: number;
  /** Additional synonym mappings to merge with defaults */
  synonyms?: Record<string, string[]>;
  /** Tool names to exclude from compression (always pass through) */
  passthrough?: string[];
  /** Enable debug logging (default: false) */
  debug?: boolean;
}
