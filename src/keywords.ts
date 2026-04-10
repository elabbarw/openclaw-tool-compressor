/**
 * Keyword extraction and synonym expansion for tool search.
 *
 * Strategy: tool names are the highest-signal source (split on underscores
 * and hyphens). Descriptions add supplementary keywords. Synonyms bridge
 * the gap between what users say ("ticket", "PR", "doc") and what tools
 * are named ("issue", "merge_request", "confluence_page").
 */

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "shall",
  "should", "may", "might", "must", "can", "could", "of", "in", "to",
  "for", "with", "on", "at", "from", "by", "about", "as", "into",
  "through", "during", "before", "after", "above", "below", "between",
  "and", "but", "or", "nor", "not", "so", "yet", "both", "either",
  "neither", "each", "every", "all", "any", "few", "more", "most",
  "other", "some", "such", "no", "only", "own", "same", "than", "too",
  "very", "just", "because", "if", "when", "where", "how", "what",
  "which", "who", "whom", "this", "that", "these", "those", "it", "its",
  "they", "them", "their", "we", "us", "our", "you", "your", "he", "him",
  "his", "she", "her", "my", "me", "i", "get", "set", "use", "new",
]);

/** Default synonym map - bridges natural language to tool naming conventions */
const DEFAULT_SYNONYMS: Record<string, string[]> = {
  mr: ["merge_request", "merge", "request"],
  pr: ["merge_request", "merge", "request"],
  ticket: ["issue", "jira"],
  bug: ["issue"],
  repo: ["repository", "project"],
  ci: ["pipeline"],
  cd: ["pipeline", "deployment"],
  deploy: ["deployment", "environment"],
  page: ["confluence", "wiki"],
  doc: ["confluence", "wiki", "page"],
  docs: ["confluence", "wiki", "page"],
  board: ["agile", "sprint"],
  workflow: ["n8n", "automation"],
  automation: ["n8n", "workflow"],
  cred: ["credential"],
  tag: ["label"],
  comment: ["note", "discussion"],
  attach: ["attachment", "upload"],
  link: ["issue_link", "remote"],
  email: ["mail", "gmail", "outlook", "draft", "thread"],
  message: ["chat", "slack", "teams", "send"],
  file: ["read", "write", "contents", "upload"],
  search: ["find", "query", "list"],
  delete: ["remove", "destroy"],
  edit: ["update", "modify", "change"],
  create: ["add", "new", "make"],
};

/**
 * Extract search keywords from a tool's name and description.
 *
 * Name tokens get highest priority in search scoring.
 * Description tokens supplement for broader matching.
 */
export function extractKeywords(
  toolName: string,
  description: string = ""
): string[] {
  const keywords: string[] = [];
  const seen = new Set<string>();

  // Tool name tokens (highest signal)
  const nameTokens = toolName
    .toLowerCase()
    .replace(/[-_.]/g, " ")
    .split(/\s+/);

  for (const token of nameTokens) {
    const t = token.trim();
    if (t.length > 1 && !STOP_WORDS.has(t) && !seen.has(t)) {
      keywords.push(t);
      seen.add(t);
    }
  }

  // Description tokens (supplementary)
  if (description) {
    const descClean = description
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ");
    const descTokens = descClean.split(/\s+/);

    for (const token of descTokens) {
      const t = token.trim();
      if (t.length > 2 && !STOP_WORDS.has(t) && !seen.has(t)) {
        keywords.push(t);
        seen.add(t);
      }
    }
  }

  return keywords;
}

/**
 * Expand a set of query tokens using the synonym map.
 * Returns the union of original tokens and all matched synonyms.
 */
export function expandWithSynonyms(
  tokens: Set<string>,
  customSynonyms?: Record<string, string[]>
): Set<string> {
  const synonyms = customSynonyms
    ? { ...DEFAULT_SYNONYMS, ...customSynonyms }
    : DEFAULT_SYNONYMS;

  const expanded = new Set(tokens);
  for (const token of tokens) {
    const mapped = synonyms[token];
    if (mapped) {
      for (const syn of mapped) {
        expanded.add(syn);
      }
    }
  }
  return expanded;
}
