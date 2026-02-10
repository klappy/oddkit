/**
 * Orchestration logic for oddkit MCP Worker
 *
 * Uses ZipBaselineFetcher for tiered caching of baseline repos.
 * Supports canon repo overrides with klappy.dev fallback.
 *
 * v2: Unified handler with action routing, BM25 search, state threading,
 * and consistent response envelope.
 */

import { ZipBaselineFetcher, type Env, type BaselineIndex, type IndexEntry } from "./zip-baseline-fetcher";
import { buildBM25Index, searchBM25, type BM25Index } from "./bm25";
import pkg from "../package.json";

export type { Env };

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface OddkitState {
  phase: "exploration" | "planning" | "execution";
  gates_passed: string[];
  decisions_encoded: string[];
  unresolved: string[];
  canon_refs: string[];
}

export interface OddkitEnvelope {
  action: string;
  result: unknown;
  state?: OddkitState;
  assistant_text: string;
  debug?: {
    baseline_url?: string;
    canon_url?: string;
    canon_commit?: string;
    generated_at?: string;
    search_index_size?: number;
    duration_ms?: number;
    [key: string]: unknown;
  };
}

export interface UnifiedParams {
  action: string;
  input: string;
  context?: string;
  mode?: string;
  canon_url?: string;
  state?: OddkitState;
  env: Env;
}

// Keep backward-compat type for existing callers
export type OrchestrateResult = OddkitEnvelope;

export interface OrchestrateOptions {
  message: string;
  action?: string;
  env: Env;
  canonUrl?: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// BM25 Index Cache (per-request, lazy)
// ──────────────────────────────────────────────────────────────────────────────

let cachedBM25Index: BM25Index | null = null;
let cachedBM25Entries: IndexEntry[] | null = null;

function getBM25Index(entries: IndexEntry[]): BM25Index {
  // Reuse if entries haven't changed (same array reference)
  if (cachedBM25Index && cachedBM25Entries === entries) {
    return cachedBM25Index;
  }

  const documents = entries.map((entry) => ({
    id: entry.path,
    text: [
      entry.title || "",
      entry.path.replace(/[/_.-]/g, " "),
      (entry.tags || []).join(" "),
      entry.excerpt || "",
    ].join(" "),
  }));

  cachedBM25Index = buildBM25Index(documents);
  cachedBM25Entries = entries;
  return cachedBM25Index;
}

// ──────────────────────────────────────────────────────────────────────────────
// State management
// ──────────────────────────────────────────────────────────────────────────────

function initState(existing?: OddkitState): OddkitState {
  return {
    phase: existing?.phase || "exploration",
    gates_passed: existing?.gates_passed || [],
    decisions_encoded: existing?.decisions_encoded || [],
    unresolved: existing?.unresolved || [],
    canon_refs: existing?.canon_refs || [],
  };
}

function addCanonRefs(state: OddkitState, paths: string[]): OddkitState {
  const existing = new Set(state.canon_refs);
  for (const p of paths) {
    if (!existing.has(p)) {
      state.canon_refs.push(p);
    }
  }
  return state;
}

// ──────────────────────────────────────────────────────────────────────────────
// Action detection (for backward-compat orchestrate routing)
// ──────────────────────────────────────────────────────────────────────────────

function detectAction(message: string): string {
  const lower = message.toLowerCase().trim();

  if (
    lower.startsWith("preflight:") ||
    lower.startsWith("before i implement") ||
    lower.includes("what should i read first") ||
    /^implement\s+\w+/.test(lower)
  ) {
    return "preflight";
  }

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

  if (
    /\b(done|finished|completed|shipped|merged|fixed|implemented)\b/i.test(lower) &&
    lower.length > 10
  ) {
    return "validate";
  }

  if (
    lower.startsWith("explain") ||
    lower.includes("why did you") ||
    lower.includes("what happened")
  ) {
    return "explain";
  }

  return "librarian";
}

// ──────────────────────────────────────────────────────────────────────────────
// Epistemic mode / claim / transition detection
// ──────────────────────────────────────────────────────────────────────────────

const MODE_SIGNALS: Record<string, RegExp[]> = {
  exploration: [
    /\b(what if|wonder|explore|brainstorm|idea|thinking about|consider|curious)\b/i,
    /\b(might|could|maybe|possibly|potentially|hypothetically)\b/i,
    /\b(understand|learn|discover|investigate|research|look into)\b/i,
    /\?/,
  ],
  planning: [
    /\b(plan|design|architect|structure|organize|outline|strategy)\b/i,
    /\b(decide|choose|select|pick|determine|evaluate|compare)\b/i,
    /\b(requirements?|constraints?|scope|specification|criteria)\b/i,
    /\b(before|prepare|ready to|getting ready|setting up)\b/i,
  ],
  execution: [
    /\b(implement|build|code|write|create|deploy|ship|release)\b/i,
    /\b(fix|debug|resolve|patch|update|modify|change|refactor)\b/i,
    /\b(test|verify|validate|confirm|check|ensure)\b/i,
    /\b(doing|building|working on|in progress|currently)\b/i,
  ],
};

function detectMode(input: string): { mode: string; confidence: string } {
  const scores: Record<string, number> = { exploration: 0, planning: 0, execution: 0 };
  for (const [mode, patterns] of Object.entries(MODE_SIGNALS)) {
    for (const p of patterns) {
      if (p.test(input)) scores[mode]++;
    }
  }
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const top = sorted[0][1];
  const second = sorted.length > 1 ? sorted[1][1] : 0;
  const confidence = top === 0 ? "low" : top - second >= 2 ? "strong" : top >= 2 ? "partial" : "low";
  return { mode: sorted[0][0], confidence };
}

function detectClaimType(input: string): string {
  if (/\b(must|always|never|guaranteed|impossible|certain|definitely|obviously|clearly)\b/i.test(input)) return "strong_claim";
  if (/\b(should|plan to|going to|will|propose|suggest|recommend|let's|want to)\b/i.test(input)) return "proposal";
  if (/\b(assume|assuming|presume|given that|since|because|if we)\b/i.test(input)) return "assumption";
  return "observation";
}

function detectTransition(input: string): { from: string; to: string } {
  if (/\b(ready to build|ready to implement|start building|let's code|start coding)\b/i.test(input)) return { from: "planning", to: "execution" };
  if (/\b(ready to plan|start planning|let's plan|time to plan|move to planning|moving to planning)\b/i.test(input)) return { from: "exploration", to: "planning" };
  if (/\b(moving to execution|moving to build)\b/i.test(input)) return { from: "planning", to: "execution" };
  if (/\b(back to exploration|need to rethink|step back|reconsider)\b/i.test(input)) return { from: "execution", to: "exploration" };
  if (/\b(ship|deploy|release|go live|push to prod)\b/i.test(input)) return { from: "execution", to: "completion" };
  if (/\b(ready|let's go|proceed|move forward|next step)\b/i.test(input)) return { from: "exploration", to: "planning" };
  return { from: "unknown", to: "unknown" };
}

function detectEncodeType(input: string): string {
  if (/\b(decided|decision|chose|choosing|selected|committed to|going with)\b/i.test(input)) return "decision";
  if (/\b(learned|insight|realized|discovered|found that|turns out)\b/i.test(input)) return "insight";
  if (/\b(boundary|limit|constraint|rule|prohibition|must not|never)\b/i.test(input)) return "boundary";
  if (/\b(override|exception|despite|even though|notwithstanding)\b/i.test(input)) return "override";
  return "decision";
}

// ──────────────────────────────────────────────────────────────────────────────
// Score entries (legacy, kept for backward-compat in existing action handlers)
// ──────────────────────────────────────────────────────────────────────────────

function scoreEntries(entries: IndexEntry[], query: string): Array<IndexEntry & { score: number }> {
  const terms = query.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter(t => t.length > 2);

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

      if (entry.authority_band === "governing") score += 5;
      if (entry.intent === "promoted") score += 3;
      if (entry.source === "canon") score += 2;

      return { ...entry, score };
    })
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score);
}

// ──────────────────────────────────────────────────────────────────────────────
// Individual action handlers
// ──────────────────────────────────────────────────────────────────────────────

async function runSearch(
  input: string,
  fetcher: ZipBaselineFetcher,
  canonUrl?: string,
  state?: OddkitState,
): Promise<OddkitEnvelope> {
  const startMs = Date.now();
  const index = await fetcher.getIndex(canonUrl);
  const bm25 = getBM25Index(index.entries);
  const results = searchBM25(bm25, input, 5);

  // Map scores back to entries
  const entryMap = new Map(index.entries.map((e) => [e.path, e]));
  const hits = results
    .map((r) => {
      const entry = entryMap.get(r.id);
      if (!entry) return null;
      return { ...entry, score: r.score };
    })
    .filter(Boolean) as Array<IndexEntry & { score: number }>;

  const updatedState = state ? addCanonRefs(initState(state), hits.map((h) => h.path)) : undefined;

  if (hits.length === 0) {
    return {
      action: "search",
      result: {
        status: "NO_MATCH",
        docs_considered: index.entries.length,
        hits: [],
      },
      state: updatedState,
      assistant_text: `Searched ${index.stats.total} documents but found no matches for "${input}". Try rephrasing or ask with action "catalog" to see available documentation.`,
      debug: {
        baseline_url: index.baseline_url,
        canon_url: canonUrl,
        search_index_size: bm25.N,
        duration_ms: Date.now() - startMs,
        generated_at: new Date().toISOString(),
      },
    };
  }

  // Fetch excerpts for top results
  const evidence: Array<{ quote: string; citation: string; source: string }> = [];
  for (const entry of hits.slice(0, 3)) {
    const content = await fetcher.getFile(entry.path, canonUrl);
    if (content) {
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

  const assistantLines = [
    `Found ${hits.length} result(s) for: "${input}"`,
    "",
    ...evidence.map((e) => `> ${e.quote}\n— ${e.citation} (${e.source})`),
    "",
    "Results:",
    ...hits.map((r) => `- \`${r.path}\` — ${r.title} (score: ${r.score.toFixed(2)}, ${r.source})`),
  ];

  return {
    action: "search",
    result: {
      status: "FOUND",
      hits: hits.map((h) => ({
        uri: h.uri,
        path: h.path,
        title: h.title,
        tags: h.tags,
        score: h.score,
        snippet: h.excerpt,
        source: h.source,
      })),
      evidence,
      docs_considered: index.entries.length,
    },
    state: updatedState,
    assistant_text: assistantLines.join("\n").trim(),
    debug: {
      baseline_url: index.baseline_url,
      canon_url: canonUrl,
      search_index_size: bm25.N,
      duration_ms: Date.now() - startMs,
      generated_at: new Date().toISOString(),
    },
  };
}

async function runGet(
  input: string,
  fetcher: ZipBaselineFetcher,
  canonUrl?: string,
  state?: OddkitState,
): Promise<OddkitEnvelope> {
  const startMs = Date.now();

  // Resolve URI to path: klappy://canon/values/orientation → canon/values/orientation.md
  let path = input;
  if (path.startsWith("klappy://")) {
    path = path.replace("klappy://", "");
  }
  if (!path.endsWith(".md")) {
    path = path + ".md";
  }

  const content = await fetcher.getFile(path, canonUrl);
  const updatedState = state ? addCanonRefs(initState(state), [path]) : undefined;

  if (!content) {
    return {
      action: "get",
      result: { error: `Document not found: ${input}`, path },
      state: updatedState,
      assistant_text: `Document not found: \`${input}\`. Use action "search" or "catalog" to find available documents.`,
      debug: { duration_ms: Date.now() - startMs, generated_at: new Date().toISOString() },
    };
  }

  return {
    action: "get",
    result: { path, content, content_hash: hashString(content) },
    state: updatedState,
    assistant_text: content,
    debug: { duration_ms: Date.now() - startMs, generated_at: new Date().toISOString() },
  };
}

function runVersion(env: Env): OddkitEnvelope {
  return {
    action: "version",
    result: {
      oddkit_version: env.ODDKIT_VERSION || pkg.version,
      baseline_url: env.BASELINE_URL,
    },
    assistant_text: `oddkit v${env.ODDKIT_VERSION || pkg.version}`,
    debug: { generated_at: new Date().toISOString() },
  };
}

async function runInvalidateCache(
  fetcher: ZipBaselineFetcher,
  canonUrl?: string,
): Promise<OddkitEnvelope> {
  await fetcher.invalidateCache(canonUrl);
  // Also invalidate the in-memory BM25 index
  cachedBM25Index = null;
  cachedBM25Entries = null;

  return {
    action: "invalidate_cache",
    result: { success: true, canon_url: canonUrl },
    assistant_text: `Cache invalidated${canonUrl ? ` for ${canonUrl}` : ""}. Next request will fetch fresh data.`,
    debug: { generated_at: new Date().toISOString() },
  };
}

// Kept for backward-compat: old librarian using scoreEntries
async function runLibrarian(
  message: string,
  fetcher: ZipBaselineFetcher,
  canonUrl?: string,
  state?: OddkitState,
): Promise<OddkitEnvelope> {
  // Delegate to search (BM25) for better results
  return runSearch(message, fetcher, canonUrl, state);
}

async function runValidate(message: string, state?: OddkitState): Promise<OddkitEnvelope> {
  const artifactPatterns = /\b(\w+\.(png|jpg|jpeg|gif|mp4|mov|pdf|log|txt))\b/gi;
  const artifacts = [...message.matchAll(artifactPatterns)].map((m) => m[1]);
  const hasScreenshot = artifacts.some((a) => /\.(png|jpg|jpeg|gif)$/i.test(a));
  const hasVideo = artifacts.some((a) => /\.(mp4|mov)$/i.test(a));
  const gaps: string[] = [];
  if (!hasScreenshot && !hasVideo) gaps.push("visual proof (screenshot or recording)");

  if (gaps.length > 0) {
    return {
      action: "validate",
      result: { verdict: "NEEDS_ARTIFACTS", claims: [message], provided_artifacts: artifacts, gaps },
      state: state ? initState(state) : undefined,
      assistant_text: `NEEDS_ARTIFACTS\n\nClaims:\n- ${message}\n\nProvided: ${artifacts.length > 0 ? artifacts.join(", ") : "None"}\n\nMissing:\n${gaps.map((g) => `- ${g}`).join("\n")}`,
      debug: { generated_at: new Date().toISOString() },
    };
  }

  return {
    action: "validate",
    result: { verdict: "VERIFIED", claims: [message], provided_artifacts: artifacts },
    state: state ? initState(state) : undefined,
    assistant_text: `VERIFIED\n\nClaims:\n- ${message}\n\nEvidence:\n${artifacts.map((a) => `- ${a}`).join("\n")}`,
    debug: { generated_at: new Date().toISOString() },
  };
}

async function runCatalog(
  fetcher: ZipBaselineFetcher,
  canonUrl?: string,
  state?: OddkitState,
): Promise<OddkitEnvelope> {
  const startMs = Date.now();
  const index = await fetcher.getIndex(canonUrl);

  const byTag: Record<string, IndexEntry[]> = {};
  for (const entry of index.entries) {
    for (const tag of entry.tags || ["other"]) {
      if (!byTag[tag]) byTag[tag] = [];
      byTag[tag].push(entry);
    }
  }

  const startHere = index.entries
    .filter(
      (e) => e.path.includes("QUICKSTART") || e.path.includes("README") || e.title.toLowerCase().includes("getting started"),
    )
    .slice(0, 3);

  const dod = index.entries.find((e) => e.path.toLowerCase().includes("definition-of-done"));

  const topTags = Object.entries(byTag)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 5);

  const assistantText = [
    `ODD Documentation Catalog`,
    ``,
    `Total: ${index.stats.total} docs (${index.stats.canon} canon, ${index.stats.baseline} baseline)`,
    canonUrl ? `Canon override: ${canonUrl}` : "",
    ``,
    `Start here:`,
    ...startHere.map((e) => `- \`${e.path}\` — ${e.title}`),
    dod ? `\nDefinition of Done: \`${dod.path}\`` : "",
    ``,
    `Top categories:`,
    ...topTags.map(([tag, entries]) => `- ${tag} (${entries.length}): ${entries.slice(0, 2).map((e) => e.title).join(", ")}`),
  ]
    .filter(Boolean)
    .join("\n")
    .trim();

  return {
    action: "catalog",
    result: {
      total: index.stats.total,
      canon: index.stats.canon,
      baseline: index.stats.baseline,
      categories: Object.keys(byTag),
      start_here: startHere.map((e) => e.path),
    },
    state: state ? initState(state) : undefined,
    assistant_text: assistantText,
    debug: {
      canon_url: canonUrl,
      baseline_url: index.baseline_url,
      generated_at: index.generated_at,
      duration_ms: Date.now() - startMs,
    },
  };
}

async function runPreflight(
  message: string,
  fetcher: ZipBaselineFetcher,
  canonUrl?: string,
  state?: OddkitState,
): Promise<OddkitEnvelope> {
  const startMs = Date.now();
  const index = await fetcher.getIndex(canonUrl);
  const topic = message.replace(/^preflight:\s*/i, "").trim();
  const results = scoreEntries(index.entries, topic).slice(0, 5);

  const dodEntry = index.entries.find((e) => e.path.toLowerCase().includes("definition-of-done"));
  const constraints = index.entries
    .filter((e) => e.path.includes("constraint") || e.authority_band === "governing")
    .slice(0, 3);

  const assistantText = [
    `Preflight: ${topic}`,
    ``,
    `Start here:`,
    ...results.slice(0, 3).map((r) => `- \`${r.path}\` — ${r.title}`),
    ``,
    `Definition of Done:`,
    dodEntry ? `- \`${dodEntry.path}\`` : "- Check canon/definition-of-done.md",
    ``,
    `Constraints:`,
    ...constraints.map((c) => `- \`${c.path}\` — ${c.title}`),
    ``,
    `Before claiming done:`,
    `- Provide visual proof for UI changes`,
    `- Include test output for logic changes`,
    `- Reference any decisions made`,
  ].join("\n").trim();

  return {
    action: "preflight",
    result: {
      topic,
      start_here: results.slice(0, 3).map((r) => r.path),
      dod: dodEntry?.path,
      constraints: constraints.map((c) => c.path),
      docs_available: index.stats.total,
    },
    state: state ? initState(state) : undefined,
    assistant_text: assistantText,
    debug: {
      docs_considered: index.entries.length,
      canon_url: canonUrl,
      duration_ms: Date.now() - startMs,
      generated_at: new Date().toISOString(),
    },
  };
}

async function runOrientAction(
  input: string,
  fetcher: ZipBaselineFetcher,
  canonUrl?: string,
  state?: OddkitState,
): Promise<OddkitEnvelope> {
  const startMs = Date.now();
  const { mode, confidence } = detectMode(input);
  const index = await fetcher.getIndex(canonUrl);
  const results = scoreEntries(index.entries, input).slice(0, 3);

  const canonRefs: Array<{ path: string; quote: string }> = [];
  for (const entry of results) {
    const content = await fetcher.getFile(entry.path, canonUrl);
    if (content) {
      const stripped = content.replace(/^---[\s\S]*?---\n/, "");
      const lines = stripped.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
      canonRefs.push({ path: `${entry.path}#${entry.title}`, quote: lines.slice(0, 2).join(" ").slice(0, 150) });
    }
  }

  const assumptions: string[] = [];
  for (const s of input.split(/[.!?\n]+/).filter((s) => s.trim().length > 5)) {
    if (/\b(is|are|will|should|must|always|never|obviously|clearly)\b/i.test(s) && !s.endsWith("?")) {
      assumptions.push(s.trim());
    }
  }

  const questions: string[] = [];
  if (mode === "exploration") {
    questions.push("What specific problem are you trying to solve?", "What constraints or boundaries apply here?", "What would success look like?");
  } else if (mode === "planning") {
    questions.push("What decisions have been locked vs. still open?", "What are the irreversible aspects of this plan?", "What evidence supports this approach over alternatives?");
  } else {
    questions.push("Has the plan been validated against constraints?", "What does the definition of done look like?", "What artifacts will demonstrate completion?");
  }

  // Update state
  const updatedState = state ? initState(state) : undefined;
  if (updatedState) {
    updatedState.phase = mode as OddkitState["phase"];
    updatedState.unresolved = [...updatedState.unresolved, ...assumptions.slice(0, 3)];
    addCanonRefs(updatedState, canonRefs.map((r) => r.path));
  }

  const lines = [`Orientation: ${mode} mode (${confidence} confidence)`, ""];
  if (assumptions.length > 0) {
    lines.push("Assumptions detected:");
    for (const a of assumptions.slice(0, 3)) lines.push(`  - ${a}`);
    lines.push("");
  }
  lines.push("Questions to answer before progressing:");
  for (const q of questions) lines.push(`  - ${q}`);
  lines.push("");
  if (canonRefs.length > 0) {
    lines.push("Relevant canon:");
    for (const r of canonRefs) {
      lines.push(`  > ${r.quote}`);
      lines.push(`  — ${r.path}`);
      lines.push("");
    }
  }

  return {
    action: "orient",
    result: { status: "ORIENTED", current_mode: mode, mode_confidence: confidence, assumptions, suggested_questions: questions, canon_refs: canonRefs },
    state: updatedState,
    assistant_text: lines.join("\n").trim(),
    debug: { duration_ms: Date.now() - startMs, generated_at: new Date().toISOString() },
  };
}

async function runChallengeAction(
  input: string,
  modeHint: string | undefined,
  fetcher: ZipBaselineFetcher,
  canonUrl?: string,
  state?: OddkitState,
): Promise<OddkitEnvelope> {
  const startMs = Date.now();
  const claimType = detectClaimType(input);
  const index = await fetcher.getIndex(canonUrl);
  const results = scoreEntries(index.entries, `constraints challenges risks ${input}`).slice(0, 4);

  const canonConstraints: Array<{ citation: string; quote: string }> = [];
  const tensions: Array<{ type: string; message: string }> = [];
  for (const entry of results) {
    const content = await fetcher.getFile(entry.path, canonUrl);
    if (content) {
      const stripped = content.replace(/^---[\s\S]*?---\n/, "");
      const lines = stripped.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
      const excerpt = lines.slice(0, 2).join(" ").slice(0, 150);
      canonConstraints.push({ citation: `${entry.path}#${entry.title}`, quote: excerpt });
      if (/\bMUST NOT\b/.test(excerpt)) tensions.push({ type: "prohibition", message: `Canon prohibition found in ${entry.path}` });
      else if (/\bMUST\b/.test(excerpt)) tensions.push({ type: "requirement", message: `Canon requirement found in ${entry.path}` });
    }
  }

  const missing: string[] = [];
  if (!/\bevidence\b/i.test(input) && !/\bdata\b/i.test(input)) missing.push("No evidence cited — claims without evidence are assumptions");
  if (claimType === "strong_claim" || claimType === "proposal") {
    if (!/\balternative/i.test(input)) missing.push("No alternatives mentioned");
    if (!/\brisk/i.test(input) && !/\bcost\b/i.test(input)) missing.push("No risks or costs acknowledged");
  }

  const challenges: string[] = [];
  if (claimType === "strong_claim") {
    challenges.push("What evidence would disprove this?", "Under what conditions does this NOT hold?", "Who would disagree, and why?");
  } else if (claimType === "proposal") {
    challenges.push("What's the cost of being wrong?", "What alternatives were considered?", "What would need to be true for this to fail?");
  } else if (claimType === "assumption") {
    challenges.push("Has this assumption been validated?", "What if this assumption is wrong — what breaks?");
  } else {
    challenges.push("Is this observation representative?", "What context might change this?");
  }

  const reframings: string[] = [];
  if (claimType === "strong_claim") reframings.push("Reframe as hypothesis: 'We believe X because Y, and would reconsider if Z'");
  if (claimType === "assumption") reframings.push("Make explicit: state the assumption and how you'd validate it");
  if (claimType === "proposal") reframings.push("Add optionality: 'We're choosing X over Y because Z, reversible until W'");

  // Update state
  const updatedState = state ? initState(state) : undefined;
  if (updatedState && missing.length > 0) {
    updatedState.unresolved = [...updatedState.unresolved, ...missing];
  }

  const lines = [`Challenge (${claimType}):`, ""];
  if (tensions.length > 0) { lines.push("Tensions found:"); for (const t of tensions) lines.push(`  - [${t.type}] ${t.message}`); lines.push(""); }
  if (missing.length > 0) { lines.push("Missing prerequisites:"); for (const m of missing) lines.push(`  - ${m}`); lines.push(""); }
  lines.push("Questions to address:"); for (const c of challenges) lines.push(`  - ${c}`); lines.push("");
  if (reframings.length > 0) { lines.push("Suggested reframings:"); for (const r of reframings) lines.push(`  - ${r}`); lines.push(""); }
  if (canonConstraints.length > 0) { lines.push("Canon constraints:"); for (const c of canonConstraints) { lines.push(`  > ${c.quote}`); lines.push(`  — ${c.citation}`); lines.push(""); } }

  return {
    action: "challenge",
    result: { status: "CHALLENGED", claim_type: claimType, tensions, missing_prerequisites: missing, challenges, suggested_reframings: reframings, canon_constraints: canonConstraints },
    state: updatedState,
    assistant_text: lines.join("\n").trim(),
    debug: { duration_ms: Date.now() - startMs, generated_at: new Date().toISOString() },
  };
}

async function runGateAction(
  input: string,
  context: string | undefined,
  fetcher: ZipBaselineFetcher,
  canonUrl?: string,
  state?: OddkitState,
): Promise<OddkitEnvelope> {
  const startMs = Date.now();
  const transition = detectTransition(input);
  const fullInput = context ? `${input}\n${context}` : input;

  interface Prereq { id: string; description: string; required: boolean }
  const prereqs: Prereq[] = [];
  if (transition.from === "exploration" && transition.to === "planning") {
    prereqs.push({ id: "problem_defined", description: "Problem statement is clearly defined", required: true });
    prereqs.push({ id: "constraints_reviewed", description: "Relevant constraints have been reviewed", required: true });
  } else if (transition.from === "planning" && transition.to === "execution") {
    prereqs.push({ id: "decisions_locked", description: "Key decisions are locked", required: true });
    prereqs.push({ id: "dod_defined", description: "Definition of done is clear", required: true });
    prereqs.push({ id: "irreversibility_assessed", description: "Irreversible aspects identified", required: true });
    prereqs.push({ id: "constraints_satisfied", description: "All MUST constraints are addressable", required: true });
  } else if (transition.to === "completion") {
    prereqs.push({ id: "dod_met", description: "DoD criteria met with evidence", required: true });
    prereqs.push({ id: "artifacts_present", description: "Required artifacts present", required: true });
  }

  const met: string[] = [];
  const unmet: string[] = [];
  const unknown: string[] = [];
  const checkPatterns: Record<string, RegExp> = {
    problem_defined: /\b(problem|goal|objective|need|issue)\b/i,
    constraints_reviewed: /\b(constraint|rule|policy|reviewed|checked)\b/i,
    decisions_locked: /\b(decided|locked|chosen|selected|committed)\b/i,
    dod_defined: /\b(definition of done|dod|done when|acceptance criteria)\b/i,
    irreversibility_assessed: /\b(irreversib|can't undo|one-way|point of no return)\b/i,
    constraints_satisfied: /\b(constraints? (met|satisfied|addressed))\b/i,
    dod_met: /\b(done|complete|finished|all criteria)\b/i,
    artifacts_present: /\b(screenshot|test|log|artifact|evidence|proof)\b/i,
  };
  for (const p of prereqs) {
    const pattern = checkPatterns[p.id];
    if (pattern && pattern.test(fullInput)) met.push(p.description);
    else if (p.required) unmet.push(p.description);
    else unknown.push(p.description);
  }

  const gateStatus = unmet.length > 0 ? "NOT_READY" : "PASS";

  const index = await fetcher.getIndex(canonUrl);
  const results = scoreEntries(index.entries, `transition boundary deceleration ${input}`).slice(0, 3);
  const canonRefs: Array<{ path: string; quote: string }> = [];
  for (const entry of results) {
    const content = await fetcher.getFile(entry.path, canonUrl);
    if (content) {
      const stripped = content.replace(/^---[\s\S]*?---\n/, "");
      const lines2 = stripped.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
      canonRefs.push({ path: `${entry.path}#${entry.title}`, quote: lines2.slice(0, 2).join(" ").slice(0, 150) });
    }
  }

  // Update state
  const updatedState = state ? initState(state) : undefined;
  if (updatedState && gateStatus === "PASS") {
    updatedState.gates_passed.push(`${transition.from} → ${transition.to}`);
    if (transition.to === "planning" || transition.to === "execution") {
      updatedState.phase = transition.to as OddkitState["phase"];
    }
  }

  const lines = [`Gate: ${gateStatus} (${transition.from} → ${transition.to})`, ""];
  lines.push(`Prerequisites: ${met.length}/${prereqs.filter((p) => p.required).length} required met`, "");
  if (unmet.length > 0) { lines.push("Unmet (required):"); for (const u of unmet) lines.push(`  - ${u}`); lines.push(""); }
  if (met.length > 0) { lines.push("Met:"); for (const m of met) lines.push(`  + ${m}`); lines.push(""); }
  if (canonRefs.length > 0) { lines.push("Relevant canon:"); for (const r of canonRefs) { lines.push(`  > ${r.quote}`); lines.push(`  — ${r.path}`); lines.push(""); } }

  return {
    action: "gate",
    result: { status: gateStatus, transition, prerequisites: { met, unmet, unknown, required_met: met.length, required_total: prereqs.filter((p) => p.required).length } },
    state: updatedState,
    assistant_text: lines.join("\n").trim(),
    debug: { duration_ms: Date.now() - startMs, generated_at: new Date().toISOString() },
  };
}

async function runEncodeAction(
  input: string,
  context: string | undefined,
  fetcher: ZipBaselineFetcher,
  canonUrl?: string,
  state?: OddkitState,
): Promise<OddkitEnvelope> {
  const startMs = Date.now();
  const fullInput = context ? `${input}\n${context}` : input;
  const encodeType = detectEncodeType(input);

  const firstSentence = input.split(/[.!?\n]/)[0]?.trim() || input.slice(0, 60);
  const title = firstSentence.split(/\s+/).length <= 12 ? firstSentence : firstSentence.split(/\s+/).slice(0, 8).join(" ") + "...";

  let rationale: string | null = null;
  const rMatch = fullInput.match(/because\s+(.+?)(?:\.|$)/i) || fullInput.match(/due to\s+(.+?)(?:\.|$)/i);
  if (rMatch && rMatch[1].split(/\s+/).length >= 3) rationale = rMatch[1].trim();

  const constraints: string[] = [];
  for (const s of fullInput.split(/[.!?\n]+/).filter((s) => s.trim().length > 5)) {
    if (/\b(must|shall|required|always|never|constraint|cannot)\b/i.test(s)) constraints.push(s.trim());
  }

  let score = 0;
  if (input.split(/\s+/).length >= 10) score++;
  if (rationale) score++;
  if (constraints.length > 0) score++;
  if (/\b(alternative|instead|option|versus|vs|rather than)\b/i.test(fullInput)) score++;
  if (/\b(irreversib|reversib|temporary|permanent|until)\b/i.test(fullInput)) score++;
  const qualityLevel = score >= 4 ? "strong" : score >= 3 ? "adequate" : score >= 2 ? "weak" : "insufficient";

  const gaps: string[] = [];
  const suggestions: string[] = [];
  if (!rationale) { gaps.push("No rationale detected — add 'because...'"); suggestions.push("Add explicit rationale"); }
  if (constraints.length === 0) suggestions.push("Add constraints: what boundaries does this create?");
  if (encodeType === "decision" && !/\b(alternative|instead)\b/i.test(fullInput)) suggestions.push("Document alternatives considered");
  if (!/\b(irreversib|reversib|temporary|permanent)\b/i.test(fullInput)) suggestions.push("Note whether this is reversible or permanent");

  const artifact = {
    title,
    type: encodeType,
    decision: input.trim(),
    rationale: rationale || "(not provided — add 'because...' to strengthen)",
    constraints,
    status: qualityLevel === "strong" || qualityLevel === "adequate" ? "recorded" : "draft",
    timestamp: new Date().toISOString(),
  };

  // Update state
  const updatedState = state ? initState(state) : undefined;
  if (updatedState) {
    updatedState.decisions_encoded.push(title);
  }

  const lines = [`Encoded ${encodeType}: ${title}`, `Status: ${artifact.status} | Quality: ${qualityLevel} (${score}/5)`, ""];
  lines.push(`Decision: ${input.trim()}`, `Rationale: ${artifact.rationale}`, "");
  if (constraints.length > 0) { lines.push("Constraints:"); for (const c of constraints) lines.push(`  - ${c}`); lines.push(""); }
  if (gaps.length > 0) { lines.push("Gaps:"); for (const g of gaps) lines.push(`  - ${g}`); lines.push(""); }
  if (suggestions.length > 0) { lines.push("Suggestions:"); for (const s of suggestions) lines.push(`  - ${s}`); lines.push(""); }

  return {
    action: "encode",
    result: { status: "ENCODED", artifact, quality: { level: qualityLevel, score, max_score: 5, gaps, suggestions } },
    state: updatedState,
    assistant_text: lines.join("\n").trim(),
    debug: { duration_ms: Date.now() - startMs, generated_at: new Date().toISOString() },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Unified handler — single entry point for the consolidated `oddkit` tool
// ──────────────────────────────────────────────────────────────────────────────

const VALID_ACTIONS = [
  "orient", "challenge", "gate", "encode", "search", "get",
  "catalog", "validate", "preflight", "version", "invalidate_cache",
] as const;

export async function handleUnifiedAction(params: UnifiedParams): Promise<OddkitEnvelope> {
  const { action, input, context, mode, canon_url, state, env } = params;

  if (!VALID_ACTIONS.includes(action as (typeof VALID_ACTIONS)[number])) {
    return {
      action: "error",
      result: { error: `Unknown action: ${action}. Valid: ${VALID_ACTIONS.join(", ")}` },
      assistant_text: `Unknown action: ${action}. Valid actions: ${VALID_ACTIONS.join(", ")}`,
      debug: { generated_at: new Date().toISOString() },
    };
  }

  const fetcher = new ZipBaselineFetcher(env);

  try {
    switch (action) {
      case "orient":
        return await runOrientAction(input, fetcher, canon_url, state);
      case "challenge":
        return await runChallengeAction(input, mode, fetcher, canon_url, state);
      case "gate":
        return await runGateAction(input, context, fetcher, canon_url, state);
      case "encode":
        return await runEncodeAction(input, context, fetcher, canon_url, state);
      case "search":
        return await runSearch(input, fetcher, canon_url, state);
      case "get":
        return await runGet(input, fetcher, canon_url, state);
      case "catalog":
        return await runCatalog(fetcher, canon_url, state);
      case "validate":
        return await runValidate(input, state);
      case "preflight":
        return await runPreflight(input, fetcher, canon_url, state);
      case "version":
        return runVersion(env);
      case "invalidate_cache":
        return await runInvalidateCache(fetcher, canon_url);
      default:
        // Shouldn't reach here due to VALID_ACTIONS check above
        return await runSearch(input, fetcher, canon_url, state);
    }
  } catch (error) {
    return {
      action: "error",
      result: { error: error instanceof Error ? error.message : "Unknown error" },
      state: state ? initState(state) : undefined,
      assistant_text: `Error in ${action}: ${error instanceof Error ? error.message : "Unknown error"}`,
      debug: {
        canon_url,
        baseline_url: env.BASELINE_URL,
        generated_at: new Date().toISOString(),
      },
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Backward-compat: old runOrchestrate entry point
// Routes through unified handler but accepts legacy parameter shapes.
// ──────────────────────────────────────────────────────────────────────────────

export async function runOrchestrate(options: OrchestrateOptions): Promise<OddkitEnvelope> {
  const { message, action: explicitAction, env, canonUrl } = options;
  const action = explicitAction || detectAction(message);

  // Map legacy action names
  const actionMap: Record<string, string> = {
    librarian: "search", // librarian → search (BM25)
  };
  const mappedAction = actionMap[action] || action;

  // Route to unified handler
  return handleUnifiedAction({
    action: mappedAction,
    input: message,
    canon_url: canonUrl,
    env,
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Backward-compat: individual action exports (used by old tool routing)
// ──────────────────────────────────────────────────────────────────────────────

interface OrientOptions { input: string; env: Env; canonUrl?: string }
interface ChallengeOptions { input: string; mode?: string; env: Env; canonUrl?: string }
interface GateOptions { input: string; context?: string; env: Env; canonUrl?: string }
interface EncodeOptions { input: string; context?: string; env: Env; canonUrl?: string }

/** @deprecated Use handleUnifiedAction({ action: "orient", ... }) */
export async function runOrientActionCompat(options: OrientOptions): Promise<OddkitEnvelope> {
  return handleUnifiedAction({ action: "orient", input: options.input, canon_url: options.canonUrl, env: options.env });
}

/** @deprecated Use handleUnifiedAction({ action: "challenge", ... }) */
export async function runChallengeActionCompat(options: ChallengeOptions): Promise<OddkitEnvelope> {
  return handleUnifiedAction({ action: "challenge", input: options.input, mode: options.mode, canon_url: options.canonUrl, env: options.env });
}

/** @deprecated Use handleUnifiedAction({ action: "gate", ... }) */
export async function runGateActionCompat(options: GateOptions): Promise<OddkitEnvelope> {
  return handleUnifiedAction({ action: "gate", input: options.input, context: options.context, canon_url: options.canonUrl, env: options.env });
}

/** @deprecated Use handleUnifiedAction({ action: "encode", ... }) */
export async function runEncodeActionCompat(options: EncodeOptions): Promise<OddkitEnvelope> {
  return handleUnifiedAction({ action: "encode", input: options.input, context: options.context, canon_url: options.canonUrl, env: options.env });
}

// ──────────────────────────────────────────────────────────────────────────────
// Utility
// ──────────────────────────────────────────────────────────────────────────────

function hashString(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}
