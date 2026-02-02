/**
 * Orchestration logic for oddkit MCP Worker
 *
 * Simplified version of src/mcp/orchestrate.js adapted for Cloudflare Workers.
 * Fetches baseline from GitHub raw content instead of git clone.
 */

export interface OrchestrateOptions {
  message: string;
  action?: string;
  baselineUrl: string;
  cache?: KVNamespace;
}

export interface OrchestrateResult {
  action: string;
  result: unknown;
  assistant_text: string;
  debug?: Record<string, unknown>;
}

interface IndexEntry {
  path: string;
  title: string;
  intent?: string;
  tags?: string[];
  excerpt?: string;
}

interface BaselineIndex {
  version: string;
  entries: IndexEntry[];
}

/**
 * Detect action from message content
 */
function detectAction(message: string): string {
  const lower = message.toLowerCase().trim();

  // Preflight patterns
  if (
    lower.startsWith("preflight:") ||
    lower.startsWith("before i implement") ||
    lower.includes("what should i read first") ||
    /^implement\s+\w+/.test(lower)
  ) {
    return "preflight";
  }

  // Catalog patterns
  if (
    lower.includes("what's in odd") ||
    lower.includes("whats in odd") ||
    lower.includes("list the canon") ||
    lower.includes("show me the docs")
  ) {
    return "catalog";
  }

  // Validate patterns
  if (
    /\b(done|finished|completed|shipped|merged|fixed|implemented)\b/i.test(lower) &&
    lower.length > 10
  ) {
    return "validate";
  }

  // Explain patterns
  if (
    lower.startsWith("explain") ||
    lower.includes("why did you") ||
    lower.includes("what happened")
  ) {
    return "explain";
  }

  // Default to librarian
  return "librarian";
}

/**
 * Fetch baseline index from GitHub
 */
async function fetchBaselineIndex(
  baselineUrl: string,
  cache?: KVNamespace
): Promise<BaselineIndex> {
  const indexUrl = `${baselineUrl}/.oddkit/index.json`;
  const cacheKey = "baseline-index";

  // Try cache first
  if (cache) {
    const cached = await cache.get(cacheKey, "json");
    if (cached) {
      return cached as BaselineIndex;
    }
  }

  // Fetch from GitHub
  const response = await fetch(indexUrl);
  if (!response.ok) {
    // Return minimal index if not available
    return {
      version: "1.0",
      entries: [],
    };
  }

  const index = (await response.json()) as BaselineIndex;

  // Cache for 5 minutes
  if (cache) {
    await cache.put(cacheKey, JSON.stringify(index), { expirationTtl: 300 });
  }

  return index;
}

/**
 * Fetch a document from baseline
 */
async function fetchDoc(baselineUrl: string, path: string): Promise<string | null> {
  const docUrl = `${baselineUrl}/${path}`;
  const response = await fetch(docUrl);
  if (!response.ok) {
    return null;
  }
  return response.text();
}

/**
 * Simple text search in index
 */
function searchIndex(index: BaselineIndex, query: string): IndexEntry[] {
  const terms = query.toLowerCase().split(/\s+/);
  return index.entries
    .filter((entry) => {
      const searchable = `${entry.title} ${entry.path} ${entry.tags?.join(" ") || ""} ${entry.excerpt || ""}`.toLowerCase();
      return terms.some((term) => searchable.includes(term));
    })
    .slice(0, 5);
}

/**
 * Run librarian action
 */
async function runLibrarian(
  message: string,
  baselineUrl: string,
  cache?: KVNamespace
): Promise<OrchestrateResult> {
  const index = await fetchBaselineIndex(baselineUrl, cache);
  const results = searchIndex(index, message);

  if (results.length === 0) {
    return {
      action: "librarian",
      result: {
        status: "NO_MATCH",
        answer: "No relevant documents found.",
      },
      assistant_text: `I searched the ODD baseline but found no documents matching "${message}". Try rephrasing your question or ask "what's in ODD?" to see available documentation.`,
    };
  }

  // Fetch excerpts for top results
  const evidence: Array<{ quote: string; citation: string }> = [];
  for (const entry of results.slice(0, 3)) {
    const content = await fetchDoc(baselineUrl, entry.path);
    if (content) {
      // Extract first meaningful paragraph
      const lines = content.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
      const excerpt = lines.slice(0, 3).join(" ").slice(0, 200);
      evidence.push({
        quote: excerpt,
        citation: `${entry.path}#${entry.title}`,
      });
    }
  }

  const assistantText = `### Answer
Found ${results.length} relevant document(s) for: "${message}"

### Evidence
${evidence.map((e) => `- "${e.quote}..." — \`${e.citation}\``).join("\n")}

### Read Next
${results.map((r) => `- \`${r.path}\` — ${r.title}`).join("\n")}`;

  return {
    action: "librarian",
    result: {
      status: "SUPPORTED",
      answer: `Found ${results.length} relevant document(s)`,
      evidence,
    },
    assistant_text: assistantText,
  };
}

/**
 * Run validate action
 */
async function runValidate(message: string): Promise<OrchestrateResult> {
  // Extract claims and artifacts from message
  const artifactPatterns = /\b(\w+\.(png|jpg|jpeg|gif|mp4|mov|pdf|log|txt))\b/gi;
  const artifacts = [...message.matchAll(artifactPatterns)].map((m) => m[1]);

  // Check for required evidence types
  const hasScreenshot = artifacts.some((a) => /\.(png|jpg|jpeg|gif)$/i.test(a));
  const hasVideo = artifacts.some((a) => /\.(mp4|mov)$/i.test(a));
  const hasLog = artifacts.some((a) => /\.(log|txt)$/i.test(a));

  const gaps: string[] = [];
  if (!hasScreenshot && !hasVideo) {
    gaps.push("visual proof (screenshot or recording)");
  }

  if (gaps.length > 0) {
    return {
      action: "validate",
      result: {
        verdict: "NEEDS_ARTIFACTS",
        claims: [message],
        provided_artifacts: artifacts,
        gaps,
      },
      assistant_text: `### Verdict
NEEDS_ARTIFACTS

### Claims
- ${message}

### Provided Artifacts
${artifacts.length > 0 ? artifacts.map((a) => `- ${a}`).join("\n") : "- None detected"}

### Missing Evidence
${gaps.map((g) => `- ${g}`).join("\n")}

Please provide the missing evidence to validate completion.`,
    };
  }

  return {
    action: "validate",
    result: {
      verdict: "VERIFIED",
      claims: [message],
      provided_artifacts: artifacts,
    },
    assistant_text: `### Verdict
VERIFIED

### Claims
- ${message}

### Evidence
${artifacts.map((a) => `- ${a}`).join("\n")}

Completion validated with required artifacts.`,
  };
}

/**
 * Run catalog action
 */
async function runCatalog(
  baselineUrl: string,
  cache?: KVNamespace
): Promise<OrchestrateResult> {
  const index = await fetchBaselineIndex(baselineUrl, cache);

  // Group by intent/tags
  const byTag: Record<string, IndexEntry[]> = {};
  for (const entry of index.entries) {
    for (const tag of entry.tags || ["other"]) {
      if (!byTag[tag]) byTag[tag] = [];
      byTag[tag].push(entry);
    }
  }

  const topTags = Object.entries(byTag)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 5);

  const assistantText = `### ODD Documentation Catalog

**Start here:** docs/QUICKSTART.md

**Top categories:**
${topTags.map(([tag, entries]) => `- **${tag}**: ${entries.slice(0, 3).map((e) => e.path).join(", ")}`).join("\n")}

**Total documents:** ${index.entries.length}

Ask about any topic to get relevant documents with citations.`;

  return {
    action: "catalog",
    result: {
      total: index.entries.length,
      categories: Object.keys(byTag),
    },
    assistant_text: assistantText,
  };
}

/**
 * Run preflight action
 */
async function runPreflight(
  message: string,
  baselineUrl: string,
  cache?: KVNamespace
): Promise<OrchestrateResult> {
  const index = await fetchBaselineIndex(baselineUrl, cache);

  // Find relevant docs for the implementation
  const topic = message.replace(/^preflight:\s*/i, "").trim();
  const results = searchIndex(index, topic);

  // Look for definition of done
  const dodEntry = index.entries.find((e) =>
    e.path.toLowerCase().includes("definition-of-done")
  );

  const assistantText = `### Preflight Summary

**Topic:** ${topic}

**Start here:**
${results.slice(0, 2).map((r) => `- \`${r.path}\` — ${r.title}`).join("\n") || "- docs/QUICKSTART.md"}

**Definition of Done:**
${dodEntry ? `- \`${dodEntry.path}\`` : "- Check canon/definition-of-done.md"}

**Constraints to review:**
- Check for governing docs in canon/constraints/
- Review operational notes in docs/

**Before claiming done:**
- Provide visual proof for UI changes
- Include test output for logic changes
- Reference any decisions made

Run \`oddkit_orchestrate({ message: "What is the definition of done?" })\` for full DoD details.`;

  return {
    action: "preflight",
    result: {
      topic,
      start_here: results.slice(0, 2).map((r) => r.path),
      dod: dodEntry?.path,
    },
    assistant_text: assistantText,
  };
}

/**
 * Main orchestration entry point
 */
export async function runOrchestrate(options: OrchestrateOptions): Promise<OrchestrateResult> {
  const { message, action: explicitAction, baselineUrl, cache } = options;
  const action = explicitAction || detectAction(message);

  try {
    switch (action) {
      case "librarian":
        return await runLibrarian(message, baselineUrl, cache);
      case "validate":
        return await runValidate(message);
      case "catalog":
        return await runCatalog(baselineUrl, cache);
      case "preflight":
        return await runPreflight(message, baselineUrl, cache);
      case "explain":
        return {
          action: "explain",
          result: { note: "Explain requires session state not available in remote mode" },
          assistant_text:
            "The explain action requires session state which is not available in remote MCP mode. Please re-run the previous action if you need details.",
        };
      default:
        return await runLibrarian(message, baselineUrl, cache);
    }
  } catch (error) {
    return {
      action: "error",
      result: { error: error instanceof Error ? error.message : "Unknown error" },
      assistant_text: `An error occurred: ${error instanceof Error ? error.message : "Unknown error"}. Please try again.`,
    };
  }
}
