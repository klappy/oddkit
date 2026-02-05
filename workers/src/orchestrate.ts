/**
 * Orchestration logic for oddkit MCP Worker
 *
 * Uses ZipBaselineFetcher for tiered caching of baseline repos.
 * Supports canon repo overrides with klappy.dev fallback.
 */

import { ZipBaselineFetcher, type Env, type BaselineIndex, type IndexEntry } from "./zip-baseline-fetcher";

export type { Env };

export interface OrchestrateOptions {
  message: string;
  action?: string;
  env: Env;
  canonUrl?: string;
}

export interface OrchestrateResult {
  action: string;
  result: unknown;
  assistant_text: string;
  debug?: Record<string, unknown>;
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
    lower.includes("show me the docs") ||
    lower.includes("what documents") ||
    lower.includes("how many docs")
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
 * Score entries against a query
 */
function scoreEntries(entries: IndexEntry[], query: string): Array<IndexEntry & { score: number }> {
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);

  return entries
    .map((entry) => {
      let score = 0;
      const searchable = `${entry.title} ${entry.path} ${entry.tags?.join(" ") || ""} ${entry.excerpt || ""}`.toLowerCase();

      for (const term of terms) {
        if (entry.title?.toLowerCase().includes(term)) score += 10;
        if (entry.path.toLowerCase().includes(term)) score += 5;
        if (entry.tags?.some(t => t.toLowerCase().includes(term))) score += 8;
        if (entry.excerpt?.toLowerCase().includes(term)) score += 3;
        if (searchable.includes(term)) score += 1;
      }

      // Boost governing/promoted docs
      if (entry.authority_band === "governing") score += 5;
      if (entry.intent === "promoted") score += 3;

      // Boost canon over baseline
      if (entry.source === "canon") score += 2;

      return { ...entry, score };
    })
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score);
}

/**
 * Run librarian action
 */
async function runLibrarian(
  message: string,
  fetcher: ZipBaselineFetcher,
  canonUrl?: string
): Promise<OrchestrateResult> {
  const index = await fetcher.getIndex(canonUrl);
  const results = scoreEntries(index.entries, message).slice(0, 5);

  if (results.length === 0) {
    return {
      action: "librarian",
      result: {
        status: "NO_MATCH",
        docs_considered: index.entries.length,
        answer: "No relevant documents found.",
      },
      assistant_text: `I searched ${index.stats.total} documents (${index.stats.canon} canon, ${index.stats.baseline} baseline) but found no matches for "${message}". Try rephrasing your question or ask "what's in ODD?" to see available documentation.`,
      debug: {
        docs_considered: index.entries.length,
        canon_url: canonUrl,
        baseline_url: index.baseline_url,
      },
    };
  }

  // Fetch excerpts for top results
  const evidence: Array<{ quote: string; citation: string; source: string }> = [];
  for (const entry of results.slice(0, 3)) {
    const content = await fetcher.getFile(entry.path, canonUrl);
    if (content) {
      // Extract first meaningful paragraph
      const stripped = content.replace(/^---[\s\S]*?---\n/, "");
      const lines = stripped.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
      const excerpt = lines.slice(0, 3).join(" ").slice(0, 200);
      evidence.push({
        quote: excerpt,
        citation: `${entry.path}#${entry.title}`,
        source: entry.source,
      });
    }
  }

  const assistantText = `### Answer
Found ${results.length} relevant document(s) for: "${message}"

### Evidence
${evidence.map((e) => `- "${e.quote}..." — \`${e.citation}\` (${e.source})`).join("\n")}

### Read Next
${results.map((r) => `- \`${r.path}\` — ${r.title} (${r.source})`).join("\n")}`;

  return {
    action: "librarian",
    result: {
      status: "SUPPORTED",
      answer: `Found ${results.length} relevant document(s)`,
      evidence,
      docs_considered: index.entries.length,
    },
    assistant_text: assistantText,
    debug: {
      docs_considered: index.entries.length,
      top_scores: results.slice(0, 3).map(r => ({ path: r.path, score: r.score })),
      canon_url: canonUrl,
    },
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
  fetcher: ZipBaselineFetcher,
  canonUrl?: string
): Promise<OrchestrateResult> {
  const index = await fetcher.getIndex(canonUrl);

  // Group by intent/tags
  const byTag: Record<string, IndexEntry[]> = {};
  for (const entry of index.entries) {
    for (const tag of entry.tags || ["other"]) {
      if (!byTag[tag]) byTag[tag] = [];
      byTag[tag].push(entry);
    }
  }

  // Find start-here docs
  const startHere = index.entries.filter(
    (e) => e.path.includes("QUICKSTART") || e.path.includes("README") || e.title.toLowerCase().includes("getting started")
  ).slice(0, 3);

  // Find definition of done
  const dod = index.entries.find((e) =>
    e.path.toLowerCase().includes("definition-of-done")
  );

  const topTags = Object.entries(byTag)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 5);

  const assistantText = `### ODD Documentation Catalog

**Total documents:** ${index.stats.total} (${index.stats.canon} canon, ${index.stats.baseline} baseline)
${canonUrl ? `**Canon override:** ${canonUrl}` : ""}
**Baseline:** klappy.dev

**Start here:**
${startHere.length > 0 ? startHere.map((e) => `- \`${e.path}\` — ${e.title}`).join("\n") : "- docs/QUICKSTART.md"}

${dod ? `**Definition of Done:** \`${dod.path}\`\n` : ""}
**Top categories:**
${topTags.map(([tag, entries]) => `- **${tag}** (${entries.length}): ${entries.slice(0, 2).map((e) => e.title).join(", ")}`).join("\n")}

Ask about any topic to get relevant documents with citations.`;

  return {
    action: "catalog",
    result: {
      total: index.stats.total,
      canon: index.stats.canon,
      baseline: index.stats.baseline,
      categories: Object.keys(byTag),
      start_here: startHere.map((e) => e.path),
    },
    assistant_text: assistantText,
    debug: {
      canon_url: canonUrl,
      baseline_url: index.baseline_url,
      generated_at: index.generated_at,
    },
  };
}

/**
 * Run preflight action
 */
async function runPreflight(
  message: string,
  fetcher: ZipBaselineFetcher,
  canonUrl?: string
): Promise<OrchestrateResult> {
  const index = await fetcher.getIndex(canonUrl);

  // Find relevant docs for the implementation
  const topic = message.replace(/^preflight:\s*/i, "").trim();
  const results = scoreEntries(index.entries, topic).slice(0, 5);

  // Look for definition of done
  const dodEntry = index.entries.find((e) =>
    e.path.toLowerCase().includes("definition-of-done")
  );

  // Look for constraints
  const constraints = index.entries.filter((e) =>
    e.path.includes("constraint") || e.authority_band === "governing"
  ).slice(0, 3);

  const assistantText = `### Preflight Summary

**Topic:** ${topic}

**Start here:**
${results.slice(0, 3).map((r) => `- \`${r.path}\` — ${r.title}`).join("\n") || "- docs/QUICKSTART.md"}

**Definition of Done:**
${dodEntry ? `- \`${dodEntry.path}\`` : "- Check canon/definition-of-done.md"}

**Constraints to review:**
${constraints.length > 0 ? constraints.map((c) => `- \`${c.path}\` — ${c.title}`).join("\n") : "- Check for governing docs in canon/constraints/"}

**Before claiming done:**
- Provide visual proof for UI changes
- Include test output for logic changes
- Reference any decisions made

Run \`oddkit_orchestrate({ message: "What is the definition of done?" })\` for full DoD details.`;

  return {
    action: "preflight",
    result: {
      topic,
      start_here: results.slice(0, 3).map((r) => r.path),
      dod: dodEntry?.path,
      constraints: constraints.map((c) => c.path),
      docs_available: index.stats.total,
    },
    assistant_text: assistantText,
    debug: {
      docs_considered: index.entries.length,
      canon_url: canonUrl,
    },
  };
}

/**
 * Main orchestration entry point
 */
export async function runOrchestrate(options: OrchestrateOptions): Promise<OrchestrateResult> {
  const { message, action: explicitAction, env, canonUrl } = options;
  const action = explicitAction || detectAction(message);
  const fetcher = new ZipBaselineFetcher(env);

  try {
    switch (action) {
      case "librarian":
        return await runLibrarian(message, fetcher, canonUrl);
      case "validate":
        return await runValidate(message);
      case "catalog":
        return await runCatalog(fetcher, canonUrl);
      case "preflight":
        return await runPreflight(message, fetcher, canonUrl);
      case "explain":
        return {
          action: "explain",
          result: { note: "Explain requires session state not available in remote mode" },
          assistant_text:
            "The explain action requires session state which is not available in remote MCP mode. Please re-run the previous action if you need details.",
        };
      default:
        return await runLibrarian(message, fetcher, canonUrl);
    }
  } catch (error) {
    return {
      action: "error",
      result: { error: error instanceof Error ? error.message : "Unknown error" },
      assistant_text: `An error occurred: ${error instanceof Error ? error.message : "Unknown error"}. Please try again.`,
      debug: {
        canon_url: canonUrl,
        baseline_url: env.BASELINE_URL,
      },
    };
  }
}
