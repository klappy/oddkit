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
 * Epistemic mode detection signals
 */
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

interface OrientOptions { input: string; env: Env; canonUrl?: string }
interface ChallengeOptions { input: string; mode?: string; env: Env; canonUrl?: string }
interface GateOptions { input: string; context?: string; env: Env; canonUrl?: string }
interface EncodeOptions { input: string; context?: string; env: Env; canonUrl?: string }

/**
 * Orient action — assess goal against epistemic modes
 */
export async function runOrientAction(options: OrientOptions): Promise<OrchestrateResult> {
  const { input, env, canonUrl } = options;
  const fetcher = new ZipBaselineFetcher(env);

  try {
    const { mode, confidence } = detectMode(input);
    const index = await fetcher.getIndex(canonUrl);
    const results = scoreEntries(index.entries, input).slice(0, 3);

    // Build canon references with excerpts
    const canonRefs: Array<{ path: string; quote: string }> = [];
    for (const entry of results) {
      const content = await fetcher.getFile(entry.path, canonUrl);
      if (content) {
        const stripped = content.replace(/^---[\s\S]*?---\n/, "");
        const lines = stripped.split("\n").filter(l => l.trim() && !l.startsWith("#"));
        const excerpt = lines.slice(0, 2).join(" ").slice(0, 150);
        canonRefs.push({ path: `${entry.path}#${entry.title}`, quote: excerpt });
      }
    }

    // Detect assumptions
    const assumptions: string[] = [];
    const sentences = input.split(/[.!?\n]+/).filter(s => s.trim().length > 5);
    for (const s of sentences) {
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
      for (const r of canonRefs) { lines.push(`  > ${r.quote}`); lines.push(`  — ${r.path}`); lines.push(""); }
    }

    return {
      action: "orient",
      result: { status: "ORIENTED", current_mode: mode, mode_confidence: confidence, assumptions, suggested_questions: questions, canon_refs: canonRefs },
      assistant_text: lines.join("\n").trim(),
    };
  } catch (error) {
    return { action: "orient", result: { error: error instanceof Error ? error.message : "Unknown error" }, assistant_text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` };
  }
}

/**
 * Challenge action — pressure-test a claim against canon
 */
export async function runChallengeAction(options: ChallengeOptions): Promise<OrchestrateResult> {
  const { input, env, canonUrl } = options;
  const fetcher = new ZipBaselineFetcher(env);

  try {
    const claimType = detectClaimType(input);
    const index = await fetcher.getIndex(canonUrl);
    const results = scoreEntries(index.entries, `constraints challenges risks ${input}`).slice(0, 4);

    // Fetch canon constraints with excerpts
    const canonConstraints: Array<{ citation: string; quote: string }> = [];
    const tensions: Array<{ type: string; message: string }> = [];
    for (const entry of results) {
      const content = await fetcher.getFile(entry.path, canonUrl);
      if (content) {
        const stripped = content.replace(/^---[\s\S]*?---\n/, "");
        const lines = stripped.split("\n").filter(l => l.trim() && !l.startsWith("#"));
        const excerpt = lines.slice(0, 2).join(" ").slice(0, 150);
        canonConstraints.push({ citation: `${entry.path}#${entry.title}`, quote: excerpt });

        // Check for normative language
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
    if (claimType === "strong_claim") { challenges.push("What evidence would disprove this?", "Under what conditions does this NOT hold?", "Who would disagree, and why?"); }
    else if (claimType === "proposal") { challenges.push("What's the cost of being wrong?", "What alternatives were considered?", "What would need to be true for this to fail?"); }
    else if (claimType === "assumption") { challenges.push("Has this assumption been validated?", "What if this assumption is wrong — what breaks?"); }
    else { challenges.push("Is this observation representative?", "What context might change this?"); }

    const reframings: string[] = [];
    if (claimType === "strong_claim") reframings.push("Reframe as hypothesis: 'We believe X because Y, and would reconsider if Z'");
    if (claimType === "assumption") reframings.push("Make explicit: state the assumption and how you'd validate it");
    if (claimType === "proposal") reframings.push("Add optionality: 'We're choosing X over Y because Z, reversible until W'");

    const lines = [`Challenge (${claimType}):`, ""];
    if (tensions.length > 0) { lines.push("Tensions found:"); for (const t of tensions) lines.push(`  - [${t.type}] ${t.message}`); lines.push(""); }
    if (missing.length > 0) { lines.push("Missing prerequisites:"); for (const m of missing) lines.push(`  - ${m}`); lines.push(""); }
    lines.push("Questions to address:"); for (const c of challenges) lines.push(`  - ${c}`); lines.push("");
    if (reframings.length > 0) { lines.push("Suggested reframings:"); for (const r of reframings) lines.push(`  - ${r}`); lines.push(""); }
    if (canonConstraints.length > 0) { lines.push("Canon constraints:"); for (const c of canonConstraints) { lines.push(`  > ${c.quote}`); lines.push(`  — ${c.citation}`); lines.push(""); } }

    return {
      action: "challenge",
      result: { status: "CHALLENGED", claim_type: claimType, tensions, missing_prerequisites: missing, challenges, suggested_reframings: reframings, canon_constraints: canonConstraints },
      assistant_text: lines.join("\n").trim(),
    };
  } catch (error) {
    return { action: "challenge", result: { error: error instanceof Error ? error.message : "Unknown error" }, assistant_text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` };
  }
}

/**
 * Gate action — check transition prerequisites
 */
export async function runGateAction(options: GateOptions): Promise<OrchestrateResult> {
  const { input, context, env, canonUrl } = options;
  const fetcher = new ZipBaselineFetcher(env);

  try {
    const transition = detectTransition(input);
    const fullInput = context ? `${input}\n${context}` : input;

    // Define prerequisites per transition type
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

    // Evaluate
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
      if (pattern && pattern.test(fullInput)) { met.push(p.description); }
      else if (p.required) { unmet.push(p.description); }
      else { unknown.push(p.description); }
    }

    const status = unmet.length > 0 ? "NOT_READY" : "PASS";

    // Fetch relevant canon
    const index = await fetcher.getIndex(canonUrl);
    const results = scoreEntries(index.entries, `transition boundary deceleration ${input}`).slice(0, 3);
    const canonRefs: Array<{ path: string; quote: string }> = [];
    for (const entry of results) {
      const content = await fetcher.getFile(entry.path, canonUrl);
      if (content) {
        const stripped = content.replace(/^---[\s\S]*?---\n/, "");
        const lines2 = stripped.split("\n").filter(l => l.trim() && !l.startsWith("#"));
        canonRefs.push({ path: `${entry.path}#${entry.title}`, quote: lines2.slice(0, 2).join(" ").slice(0, 150) });
      }
    }

    const lines = [`Gate: ${status} (${transition.from} → ${transition.to})`, ""];
    lines.push(`Prerequisites: ${met.length}/${prereqs.filter(p => p.required).length} required met`, "");
    if (unmet.length > 0) { lines.push("Unmet (required):"); for (const u of unmet) lines.push(`  - ${u}`); lines.push(""); }
    if (met.length > 0) { lines.push("Met:"); for (const m of met) lines.push(`  + ${m}`); lines.push(""); }
    if (canonRefs.length > 0) { lines.push("Relevant canon:"); for (const r of canonRefs) { lines.push(`  > ${r.quote}`); lines.push(`  — ${r.path}`); lines.push(""); } }

    return {
      action: "gate",
      result: { status, transition, prerequisites: { met, unmet, unknown, required_met: met.length, required_total: prereqs.filter(p => p.required).length } },
      assistant_text: lines.join("\n").trim(),
    };
  } catch (error) {
    return { action: "gate", result: { error: error instanceof Error ? error.message : "Unknown error" }, assistant_text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` };
  }
}

/**
 * Encode action — structure a decision as a durable record
 */
export async function runEncodeAction(options: EncodeOptions): Promise<OrchestrateResult> {
  const { input, context, env, canonUrl } = options;
  const fetcher = new ZipBaselineFetcher(env);

  try {
    const fullInput = context ? `${input}\n${context}` : input;
    const encodeType = detectEncodeType(input);

    // Extract title
    const firstSentence = input.split(/[.!?\n]/)[0]?.trim() || input.slice(0, 60);
    const title = firstSentence.split(/\s+/).length <= 12 ? firstSentence : firstSentence.split(/\s+/).slice(0, 8).join(" ") + "...";

    // Extract rationale
    let rationale: string | null = null;
    const rMatch = fullInput.match(/because\s+(.+?)(?:\.|$)/i) || fullInput.match(/due to\s+(.+?)(?:\.|$)/i);
    if (rMatch && rMatch[1].split(/\s+/).length >= 3) rationale = rMatch[1].trim();

    // Extract constraints
    const constraints: string[] = [];
    for (const s of fullInput.split(/[.!?\n]+/).filter(s => s.trim().length > 5)) {
      if (/\b(must|shall|required|always|never|constraint|cannot)\b/i.test(s)) constraints.push(s.trim());
    }

    // Quality assessment
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
      title, type: encodeType, decision: input.trim(),
      rationale: rationale || "(not provided — add 'because...' to strengthen)",
      constraints, status: qualityLevel === "strong" || qualityLevel === "adequate" ? "recorded" : "draft",
      timestamp: new Date().toISOString(),
    };

    const lines = [`Encoded ${encodeType}: ${title}`, `Status: ${artifact.status} | Quality: ${qualityLevel} (${score}/5)`, ""];
    lines.push(`Decision: ${input.trim()}`, `Rationale: ${artifact.rationale}`, "");
    if (constraints.length > 0) { lines.push("Constraints:"); for (const c of constraints) lines.push(`  - ${c}`); lines.push(""); }
    if (gaps.length > 0) { lines.push("Gaps:"); for (const g of gaps) lines.push(`  - ${g}`); lines.push(""); }
    if (suggestions.length > 0) { lines.push("Suggestions:"); for (const s of suggestions) lines.push(`  - ${s}`); lines.push(""); }

    return {
      action: "encode",
      result: { status: "ENCODED", artifact, quality: { level: qualityLevel, score, max_score: 5, gaps, suggestions } },
      assistant_text: lines.join("\n").trim(),
    };
  } catch (error) {
    return { action: "encode", result: { error: error instanceof Error ? error.message : "Unknown error" }, assistant_text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` };
  }
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
      case "orient":
        return await runOrientAction({ input: message, env, canonUrl });
      case "challenge":
        return await runChallengeAction({ input: message, env, canonUrl });
      case "gate":
        return await runGateAction({ input: message, env, canonUrl });
      case "encode":
        return await runEncodeAction({ input: message, env, canonUrl });
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
