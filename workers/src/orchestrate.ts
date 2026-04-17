/**
 * Orchestration logic for oddkit MCP Worker
 *
 * Uses ZipBaselineFetcher for tiered caching of baseline repos.
 * Supports canon repo overrides with klappy.dev fallback.
 *
 * v2: Unified handler with action routing, BM25 search, state threading,
 * and consistent response envelope.
 */

import {
  ZipBaselineFetcher,
  extractSection,
  parseFullFrontmatter,
  type Env,
  type BaselineIndex,
  type IndexEntry,
  type SectionResult,
} from "./zip-baseline-fetcher";
import { buildBM25Index, searchBM25, type BM25Index } from "./bm25";
import type { RequestTracer } from "./tracing";
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
  server_time: string; // E0008.2 — UTC ISO 8601, every response, first-class primitive
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

/** Internal type — handlers return this, handleUnifiedAction stamps server_time */
type ActionResult = Omit<OddkitEnvelope, "server_time">;

// Governance-driven encoding types
interface EncodingTypeDef {
  letter: string;
  name: string;
  triggerWords: string[];
  triggerRegex: RegExp | null;
  qualityCriteria: Array<{ criterion: string; check: string; gapMessage: string }>;
}

interface ParsedArtifact {
  type: string;
  typeName: string;
  fields: string[];
  title: string;
  body: string;
}

let cachedEncodingTypes: EncodingTypeDef[] | null = null;
let cachedEncodingTypesCanonUrl: string | undefined = undefined;

// Governance-driven challenge types (parallel to EncodingTypeDef)
interface ChallengeTypeDef {
  slug: string;              // from ## Type Identity table, Slug row
  name: string;              // from ## Type Identity table, Name row
  blockquote: string;        // the opening > line after the title
  fallback: boolean;         // from frontmatter
  triggerWords: string[];    // from ## Detection Patterns code block
  triggerRegex: RegExp | null;
  questions: Array<{ question: string; tier: string }>;  // from ## Challenge Questions table
  prereqOverlays: PrereqOverlay[];  // from ## Prerequisite Overlays table
  reframings: string[];      // from ## Suggested Reframings bullets
}

interface PrereqOverlay {
  name: string;         // first column of table
  check: string;        // second column — prose description (may contain quoted keywords)
  gapMessage: string;   // third column — message if check fails
  keywords: string[];   // extracted from check description (quoted strings)
}

interface NormativeVocabulary {
  rfc2119Regex: RegExp | null;        // case-sensitive: MUST, SHALL, NEVER, etc.
  architecturalRegex: RegExp | null;  // case-insensitive: "invariant", "forcing function", etc.
  directiveLookup: Map<string, string>;  // word/phrase (lowercase key) → directive type
}

interface StakesCalibration {
  mode: string;                    // "exploration", "planning", "execution", "voice-dump", etc.
  questionTiers: string[];         // ["baseline"], ["baseline","elevated"], etc. OR empty array for "none"
  strictness: "optional" | "required" | "required_plus_source";
  reframings: "none" | "first_1" | "all" | "all_plus_block";
}

// Caches — one per governance article, each guarded by canonUrl (mirror encoding types pattern)
let cachedChallengeTypes: ChallengeTypeDef[] | null = null;
let cachedChallengeTypesCanonUrl: string | undefined = undefined;

let cachedBasePrerequisites: PrereqOverlay[] | null = null;
let cachedBasePrerequisitesCanonUrl: string | undefined = undefined;

let cachedNormativeVocabulary: NormativeVocabulary | null = null;
let cachedNormativeVocabularyCanonUrl: string | undefined = undefined;

let cachedStakesCalibration: StakesCalibration[] | null = null;
let cachedStakesCalibrationCanonUrl: string | undefined = undefined;

export interface UnifiedParams {
  action: string;
  input: string;
  context?: string;
  mode?: string;
  canon_url?: string;
  include_metadata?: boolean;
  section?: string;
  sort_by?: string;
  limit?: number;
  offset?: number;
  filter_epoch?: string;
  state?: OddkitState;
  env: Env;
  tracer?: RequestTracer;
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
  const confidence =
    top === 0 ? "low" : top - second >= 2 ? "strong" : top >= 2 ? "partial" : "low";
  return { mode: sorted[0][0], confidence };
}

function detectClaimType(input: string): string {
  if (
    /\b(must|always|never|guaranteed|impossible|certain|definitely|obviously|clearly)\b/i.test(
      input,
    )
  )
    return "strong_claim";
  if (/\b(should|plan to|going to|will|propose|suggest|recommend|let's|want to)\b/i.test(input))
    return "proposal";
  if (/\b(assume|assuming|presume|given that|since|because|if we)\b/i.test(input))
    return "assumption";
  return "observation";
}

function detectTransition(input: string): { from: string; to: string } {
  if (/\b(ready to build|ready to implement|start building|let's code|start coding)\b/i.test(input))
    return { from: "planning", to: "execution" };
  if (
    /\b(ready to plan|start planning|let's plan|time to plan|move to planning|moving to planning)\b/i.test(
      input,
    )
  )
    return { from: "exploration", to: "planning" };
  if (/\b(moving to execution|moving to build)\b/i.test(input))
    return { from: "planning", to: "execution" };
  if (/\b(back to exploration|need to rethink|step back|reconsider)\b/i.test(input))
    return { from: "execution", to: "exploration" };
  if (/\b(ship|deploy|release|go live|push to prod)\b/i.test(input))
    return { from: "execution", to: "completion" };
  if (/\b(ready|let's go|proceed|move forward|next step)\b/i.test(input))
    return { from: "exploration", to: "planning" };
  return { from: "unknown", to: "unknown" };
}

// Discover encoding types from canon governance docs
async function discoverEncodingTypes(
  fetcher: ZipBaselineFetcher,
  canonUrl?: string,
): Promise<EncodingTypeDef[]> {
  if (cachedEncodingTypes && cachedEncodingTypesCanonUrl === canonUrl) return cachedEncodingTypes;

  const index = await fetcher.getIndex(canonUrl);
  const typeArticles = index.entries.filter(
    (entry: IndexEntry) => entry.tags?.includes("encoding-type") && entry.path.includes("encoding-types/"),
  );

  const types: EncodingTypeDef[] = [];
  for (const article of typeArticles) {
    try {
      const content = await fetcher.getFile(article.path, canonUrl);
      if (!content) continue;

      const identityMatch = content.match(/\|\s*Letter\s*\|\s*([A-Z])\s*\|/);
      const nameMatch = content.match(/\|\s*Name\s*\|\s*([^|]+)\s*\|/);
      if (!identityMatch) continue;

      const letter = identityMatch[1];
      const name = nameMatch ? nameMatch[1].trim() : letter;

      const triggerSection = content.match(
        /## Trigger Words[^\n]*\n[\s\S]*?```\n([\s\S]*?)\n```/,
      );
      const triggerWords = triggerSection
        ? triggerSection[1].split(",").map((w: string) => w.trim()).filter((w: string) => w.length > 0)
        : [];
      const triggerRegex =
        triggerWords.length > 0
          ? new RegExp("\\b(" + triggerWords.map((w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")\\b", "i")
          : null;

      const criteriaSection = content.match(
        /## Quality Criteria[\s\S]*?\| Criterion[\s\S]*?\|[-|\s]+\|\n([\s\S]*?)(?=\n\n|\n##|$)/,
      );
      const qualityCriteria: Array<{ criterion: string; check: string; gapMessage: string }> = [];
      if (criteriaSection) {
        for (const row of criteriaSection[1].split("\n").filter((r: string) => r.includes("|"))) {
          const cols = row.split("|").map((c: string) => c.trim()).filter((c: string) => c.length > 0);
          if (cols.length >= 3) {
            qualityCriteria.push({
              criterion: cols[0],
              check: cols[1],
              gapMessage: cols[2].replace(/^"|"$/g, ""),
            });
          }
        }
      }

      types.push({ letter, name, triggerWords, triggerRegex, qualityCriteria });
    } catch {
      continue;
    }
  }

  if (types.length === 0) {
    // Fallback OLDC+H defaults when no governance docs in canon
    const defaults: Array<[string, string, string[]]> = [
      ["D", "Decision", ["decided", "decision", "chose", "committed to", "going with"]],
      ["O", "Observation", ["observed", "noticed", "found", "measured", "detected"]],
      ["L", "Learning", ["learned", "realized", "discovered", "turns out", "insight"]],
      ["C", "Constraint", ["must", "must not", "never", "always", "constraint", "cannot"]],
      ["H", "Handoff", ["next session", "next step", "todo", "follow up", "blocked by"]],
    ];
    for (const [letter, name, words] of defaults) {
      types.push({
        letter, name, triggerWords: words,
        triggerRegex: new RegExp("\\b(" + words.join("|") + ")\\b", "i"),
        qualityCriteria: [],
      });
    }
  }

  cachedEncodingTypes = types;
  cachedEncodingTypesCanonUrl = canonUrl;
  return types;
}

function extractKeywordsFromCheck(check: string): string[] {
  // Extract quoted substrings from check description
  // Example input: `input contains "evidence", "saw", "observed"`
  // Output: ["evidence", "saw", "observed"]
  const matches = check.match(/"([^"]+)"/g) || [];
  return matches.map((m: string) => m.replace(/^"|"$/g, ""));
}

function extractPrereqTable(content: string): PrereqOverlay[] {
  const section = content.match(
    /## Prerequisite Overlays[\s\S]*?\| Prerequisite[\s\S]*?\|[-|\s]+\|\n([\s\S]*?)(?=\n\n|\n##|$)/,
  );
  if (!section) return [];

  const overlays: PrereqOverlay[] = [];
  for (const row of section[1].split("\n").filter((r: string) => r.includes("|"))) {
    const cols = row.split("|").map((c: string) => c.trim()).filter((c: string) => c.length > 0);
    if (cols.length >= 3) {
      const check = cols[1];
      overlays.push({
        name: cols[0],
        check,
        gapMessage: cols[2].replace(/^"|"$/g, ""),
        keywords: extractKeywordsFromCheck(check),
      });
    }
  }
  return overlays;
}

async function discoverChallengeTypes(
  fetcher: ZipBaselineFetcher,
  canonUrl?: string,
): Promise<ChallengeTypeDef[]> {
  if (cachedChallengeTypes && cachedChallengeTypesCanonUrl === canonUrl) return cachedChallengeTypes;

  const index = await fetcher.getIndex(canonUrl);
  const typeArticles = index.entries.filter(
    (entry: IndexEntry) =>
      entry.tags?.includes("challenge-type") && entry.path.includes("challenge-types/"),
  );

  const types: ChallengeTypeDef[] = [];
  for (const article of typeArticles) {
    try {
      const content = await fetcher.getFile(article.path, canonUrl);
      if (!content) continue;

      // Frontmatter → fallback flag
      const metadata = parseFullFrontmatter(content) || {};
      const fallback = metadata.fallback === true;

      // Blockquote (opening > line)
      const blockquoteMatch = content.match(/^---[\s\S]*?---\s*\n+\s*#[^\n]+\n+>\s*(.+?)(?=\n\n|\n---|\n##)/s);
      const blockquote = blockquoteMatch ? blockquoteMatch[1].trim().replace(/\n>\s*/g, " ") : "";

      // ## Type Identity → Slug and Name
      const slugMatch = content.match(/\|\s*Slug\s*\|\s*([a-z0-9-]+)\s*\|/i);
      const nameMatch = content.match(/\|\s*Name\s*\|\s*([^|]+)\s*\|/i);
      if (!slugMatch) continue;
      const slug = slugMatch[1];
      const name = nameMatch ? nameMatch[1].trim() : slug;

      // ## Detection Patterns → code block of comma-separated words
      const detectionMatch = content.match(
        /## Detection Patterns[\s\S]*?```\n([\s\S]*?)\n```/,
      );
      const triggerWords = detectionMatch
        ? detectionMatch[1]
            .split(/[,\n]/)
            .map((w: string) => w.trim())
            .filter((w: string) => w.length > 0)
        : [];
      const triggerRegex =
        triggerWords.length > 0
          ? new RegExp(
              "\\b(" +
                triggerWords
                  .map((w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
                  .join("|") +
                ")\\b",
              "i",
            )
          : null;

      // ## Challenge Questions → table (Question | Stakes tier)
      const questionsSection = content.match(
        /## Challenge Questions[\s\S]*?\| Question[\s\S]*?\|[-|\s]+\|\n([\s\S]*?)(?=\n\n|\n##|$)/,
      );
      const questions: Array<{ question: string; tier: string }> = [];
      if (questionsSection) {
        for (const row of questionsSection[1].split("\n").filter((r: string) => r.includes("|"))) {
          const cols = row.split("|").map((c: string) => c.trim()).filter((c: string) => c.length > 0);
          if (cols.length >= 2) {
            questions.push({ question: cols[0], tier: cols[1].toLowerCase() });
          }
        }
      }

      // ## Prerequisite Overlays → table (Prerequisite | Check | Gap message)
      const prereqOverlays = extractPrereqTable(content);

      // ## Suggested Reframings → bulleted list
      const reframingsSection = content.match(
        /## Suggested Reframings[\s\S]*?\n((?:- [^\n]+\n?)+)/,
      );
      const reframings = reframingsSection
        ? reframingsSection[1]
            .split("\n")
            .filter((l: string) => l.startsWith("- "))
            .map((l: string) => l.slice(2).trim())
        : [];

      types.push({
        slug, name, blockquote, fallback,
        triggerWords, triggerRegex,
        questions, prereqOverlays, reframings,
      });
    } catch {
      continue;
    }
  }

  cachedChallengeTypes = types;
  cachedChallengeTypesCanonUrl = canonUrl;
  return types;
}

async function fetchBasePrerequisites(
  fetcher: ZipBaselineFetcher,
  canonUrl?: string,
): Promise<PrereqOverlay[]> {
  if (cachedBasePrerequisites && cachedBasePrerequisitesCanonUrl === canonUrl)
    return cachedBasePrerequisites;

  try {
    const content = await fetcher.getFile("odd/challenge/base-prerequisites.md", canonUrl);
    const overlays = content ? extractPrereqTable(content) : [];
    cachedBasePrerequisites = overlays;
    cachedBasePrerequisitesCanonUrl = canonUrl;
    return overlays;
  } catch {
    cachedBasePrerequisites = [];
    cachedBasePrerequisitesCanonUrl = canonUrl;
    return [];
  }
}

async function fetchNormativeVocabulary(
  fetcher: ZipBaselineFetcher,
  canonUrl?: string,
): Promise<NormativeVocabulary> {
  if (cachedNormativeVocabulary && cachedNormativeVocabularyCanonUrl === canonUrl)
    return cachedNormativeVocabulary;

  // Fallback minimal set if article is missing
  const fallback: NormativeVocabulary = {
    rfc2119Regex: /\b(MUST NOT|SHOULD NOT|MUST|SHOULD)\b/,
    architecturalRegex: null,
    directiveLookup: new Map([
      ["must", "requirement"],
      ["must not", "prohibition"],
      ["should", "recommendation"],
      ["should not", "discouragement"],
    ]),
  };

  try {
    const content = await fetcher.getFile("odd/challenge/normative-vocabulary.md", canonUrl);
    if (!content) {
      cachedNormativeVocabulary = fallback;
      cachedNormativeVocabularyCanonUrl = canonUrl;
      return fallback;
    }

    // Parse two tables under ## Normative Vocabulary
    // Table 1: ### Directive Language (RFC 2119 and Related) — 2 cols (Word | Directive type)
    // Table 2: ### Architectural Writing Load-Bearing Terms — 2 cols (Phrase | Directive type)
    const rfcSection = content.match(
      /### Directive Language[\s\S]*?\| Word[\s\S]*?\|[-|\s]+\|\n([\s\S]*?)(?=\n\n|\n###|\n##|$)/,
    );
    const archSection = content.match(
      /### Architectural[\s\S]*?\|[^|]+\|[^|]+\|\n\|[-|\s]+\|\n([\s\S]*?)(?=\n\n|\n###|\n##|$)/,
    );

    const rfcWords: string[] = [];
    const archPhrases: string[] = [];
    const lookup = new Map<string, string>();

    if (rfcSection) {
      for (const row of rfcSection[1].split("\n").filter((r: string) => r.includes("|"))) {
        const cols = row.split("|").map((c: string) => c.trim()).filter((c: string) => c.length > 0);
        if (cols.length >= 2) {
          rfcWords.push(cols[0]);
          lookup.set(cols[0].toLowerCase(), cols[1]);
        }
      }
    }

    if (archSection) {
      for (const row of archSection[1].split("\n").filter((r: string) => r.includes("|"))) {
        const cols = row.split("|").map((c: string) => c.trim()).filter((c: string) => c.length > 0);
        if (cols.length >= 2) {
          archPhrases.push(cols[0]);
          lookup.set(cols[0].toLowerCase(), cols[1]);
        }
      }
    }

    const rfcRegex =
      rfcWords.length > 0
        ? new RegExp(
            "\\b(" + [...rfcWords].sort((a, b) => b.length - a.length).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")\\b",
          )  // case-sensitive — no "i" flag
        : null;

    const archRegex =
      archPhrases.length > 0
        ? new RegExp(
            "\\b(" + [...archPhrases].sort((a, b) => b.length - a.length).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")\\b",
            "i",
          )
        : null;

    const result: NormativeVocabulary = {
      rfc2119Regex: rfcRegex,
      architecturalRegex: archRegex,
      directiveLookup: lookup,
    };
    cachedNormativeVocabulary = result;
    cachedNormativeVocabularyCanonUrl = canonUrl;
    return result;
  } catch {
    cachedNormativeVocabulary = fallback;
    cachedNormativeVocabularyCanonUrl = canonUrl;
    return fallback;
  }
}

async function fetchStakesCalibration(
  fetcher: ZipBaselineFetcher,
  canonUrl?: string,
): Promise<StakesCalibration[]> {
  if (cachedStakesCalibration && cachedStakesCalibrationCanonUrl === canonUrl)
    return cachedStakesCalibration;

  // Fallback: "surface everything" at every mode
  const fallback: StakesCalibration[] = [
    { mode: "exploration", questionTiers: ["baseline", "elevated", "rigorous"], strictness: "optional", reframings: "all" },
    { mode: "planning", questionTiers: ["baseline", "elevated", "rigorous"], strictness: "required", reframings: "all" },
    { mode: "execution", questionTiers: ["baseline", "elevated", "rigorous"], strictness: "required_plus_source", reframings: "all" },
  ];

  try {
    const content = await fetcher.getFile("odd/challenge/stakes-calibration.md", canonUrl);
    if (!content) {
      cachedStakesCalibration = fallback;
      cachedStakesCalibrationCanonUrl = canonUrl;
      return fallback;
    }

    // Parse ## Stakes Calibration table — 4 columns
    // Mode | Question tiers surfaced | Prerequisite strictness | Reframings surfaced
    const section = content.match(
      /## Stakes Calibration[\s\S]*?\| Mode[\s\S]*?\|[-|\s]+\|\n([\s\S]*?)(?=\n\n|\n##|$)/,
    );
    if (!section) {
      cachedStakesCalibration = fallback;
      cachedStakesCalibrationCanonUrl = canonUrl;
      return fallback;
    }

    const calibrations: StakesCalibration[] = [];
    for (const row of section[1].split("\n").filter((r: string) => r.includes("|"))) {
      const cols = row.split("|").map((c: string) => c.trim()).filter((c: string) => c.length > 0);
      if (cols.length < 4) continue;

      const mode = cols[0].toLowerCase();
      const tiersRaw = cols[1].toLowerCase();
      const strictRaw = cols[2].toLowerCase();
      const reframingsRaw = cols[3].toLowerCase();

      // Parse question tiers
      let questionTiers: string[];
      if (tiersRaw.includes("none")) questionTiers = [];
      else {
        questionTiers = [];
        if (tiersRaw.includes("baseline")) questionTiers.push("baseline");
        if (tiersRaw.includes("elevated")) questionTiers.push("elevated");
        if (tiersRaw.includes("rigorous")) questionTiers.push("rigorous");
      }

      // Parse strictness
      let strictness: StakesCalibration["strictness"];
      if (strictRaw.includes("source-named")) strictness = "required_plus_source";
      else if (strictRaw.includes("required")) strictness = "required";
      else strictness = "optional";

      // Parse reframings
      let reframings: StakesCalibration["reframings"];
      if (reframingsRaw.includes("block-until-addressed")) reframings = "all_plus_block";
      else if (reframingsRaw.includes("all")) reframings = "all";
      else if (reframingsRaw.includes("first 1") || reframingsRaw.includes("first one")) reframings = "first_1";
      else if (reframingsRaw.includes("none")) reframings = "none";
      else reframings = "all";

      calibrations.push({ mode, questionTiers, strictness, reframings });
    }

    if (calibrations.length === 0) {
      cachedStakesCalibration = fallback;
      cachedStakesCalibrationCanonUrl = canonUrl;
      return fallback;
    }

    cachedStakesCalibration = calibrations;
    cachedStakesCalibrationCanonUrl = canonUrl;
    return calibrations;
  } catch {
    cachedStakesCalibration = fallback;
    cachedStakesCalibrationCanonUrl = canonUrl;
    return fallback;
  }
}

function isStructuredInput(input: string): boolean {
  const lines = input.split("\n").filter((l) => l.trim().length > 0);
  return lines.length > 0 && lines.every((l) => /^[A-Z]\t/.test(l));
}

function parseStructuredInput(input: string, types: EncodingTypeDef[]): ParsedArtifact[] {
  const typeMap = new Map(types.map((t) => [t.letter, t.name]));
  return input.split("\n").filter((l) => l.trim().length > 0).map((line) => {
    const fields = line.split("\t");
    const letter = fields[0]?.trim() || "D";
    return {
      type: letter, typeName: typeMap.get(letter) || letter,
      fields, title: fields[1]?.trim() || "", body: fields[2]?.trim() || "",
    };
  });
}

function parseUnstructuredInput(input: string, types: EncodingTypeDef[]): ParsedArtifact[] {
  const paragraphs = input.split(/\n\n+/).filter((p) => p.trim().length > 0);
  const artifacts: ParsedArtifact[] = [];
  for (const para of paragraphs) {
    let matched = false;
    for (const t of types) {
      // DESIGN: no break — a paragraph can match multiple types intentionally.
      // "We must never deploy without tests" is both Decision and Constraint.
      // Multi-typing at the server level mirrors what the model would do with
      // separate TSV rows. Do not add a break here.
      if (t.triggerRegex && t.triggerRegex.test(para)) {
        const first = para.split(/[.!?\n]/)[0]?.trim() || para.slice(0, 60);
        const title = first.split(/\s+/).length <= 12 ? first : first.split(/\s+/).slice(0, 8).join(" ") + "...";
        artifacts.push({ type: t.letter, typeName: t.name, fields: [t.letter, title, para.trim()], title, body: para.trim() });
        matched = true;
      }
    }
    if (!matched) {
      const first = para.split(/[.!?\n]/)[0]?.trim() || para.slice(0, 60);
      const title = first.split(/\s+/).length <= 12 ? first : first.split(/\s+/).slice(0, 8).join(" ") + "...";
      const fallback = types[0] || { letter: "D", name: "Decision" };
      artifacts.push({ type: fallback.letter, typeName: fallback.name, fields: [fallback.letter, title, para.trim()], title, body: para.trim() });
    }
  }
  return artifacts;
}

function scoreArtifactQuality(
  artifact: ParsedArtifact,
  criteria: Array<{ criterion: string; check: string; gapMessage: string }>,
  scoringText?: string,
): { score: number; maxScore: number; level: string; gaps: string[]; suggestions: string[] } {
  const gaps: string[] = [];
  const suggestions: string[] = [];
  let score = 0;
  // Governance: context informs quality scoring. When scoringText is provided
  // (artifact.body + context), criteria check against that combined text so
  // background information in context (rationale, alternatives, evidence)
  // counts toward the artifact's quality without becoming separate artifacts.
  // See: klappy://odd/encoding-types/how-to-write-encoding-types#context-vs-input
  const text = scoringText ?? artifact.body;

  if (criteria.length === 0) {
    if (text.split(/\s+/).length >= 10) score++;
    else suggestions.push("Expand — more detail improves quality");
    if (/because|due to|since/i.test(text)) score++;
    else suggestions.push("Add rationale");
    return { score, maxScore: 2, level: score >= 2 ? "adequate" : "weak", gaps, suggestions };
  }

  for (const c of criteria) {
    const ck = c.check.toLowerCase();
    let passed = false;
    if (ck.includes("non-empty")) passed = artifact.fields.length > 3 || artifact.body.length > 0;
    else if (ck.includes("10")) passed = text.split(/\s+/).length >= 10;
    else if (ck.includes("number") || ck.includes("concrete")) passed = /\d/.test(text);
    else if (ck.includes("interpretation") || ck.includes("does not contain")) passed = !/should|better|worse|means|implies/i.test(artifact.body);
    else if (ck.includes("prohibition") || ck.includes("requirement")) passed = /must|must not|never|always|shall/i.test(artifact.body);
    else passed = text.split(/\s+/).length >= 5;
    if (passed) score++;
    else { gaps.push(c.gapMessage); suggestions.push(c.gapMessage); }
  }

  const mx = criteria.length;
  const level = score >= mx ? "strong" : score >= Math.ceil(mx * 0.6) ? "adequate" : score >= Math.ceil(mx * 0.4) ? "weak" : "insufficient";
  return { score, maxScore: mx, level, gaps, suggestions };
}

// ──────────────────────────────────────────────────────────────────────────────
// Score entries (legacy, kept for backward-compat in existing action handlers)
// ──────────────────────────────────────────────────────────────────────────────

function scoreEntries(entries: IndexEntry[], query: string): Array<IndexEntry & { score: number }> {
  const terms = query
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);

  return entries
    .map((entry) => {
      let score = 0;
      const searchable =
        `${entry.title} ${entry.path} ${entry.tags?.join(" ") || ""} ${entry.excerpt || ""}`.toLowerCase();

      for (const term of terms) {
        if (entry.title?.toLowerCase().includes(term)) score += 10;
        if (entry.path.toLowerCase().includes(term)) score += 5;
        if (entry.tags?.some((t) => t.toLowerCase().includes(term))) score += 8;
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
  includeMetadata?: boolean,
): Promise<ActionResult> {
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

  const updatedState = state
    ? addCanonRefs(
        initState(state),
        hits.map((h) => h.path),
      )
    : undefined;

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

  // Cache for fetched content to avoid redundant fetches when include_metadata is enabled
  const contentCache = new Map<string, string>();

  // Fetch excerpts for top results
  const evidence: Array<{ quote: string; citation: string; source: string }> = [];
  for (const entry of hits.slice(0, 3)) {
    const content = await fetcher.getFile(entry.path, canonUrl);
    if (content) {
      contentCache.set(entry.path, content);
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

  // When include_metadata is requested, fetch and parse frontmatter for each hit
  const hitsWithMetadata: Array<Record<string, unknown>> = [];
  for (const h of hits) {
    const hit: Record<string, unknown> = {
      uri: h.uri,
      path: h.path,
      title: h.title,
      tags: h.tags,
      score: h.score,
      snippet: h.excerpt,
      source: h.source,
    };
    if (includeMetadata) {
      // Reuse cached content from evidence fetch, or fetch fresh if not cached
      const fileContent = contentCache.get(h.path) ?? (await fetcher.getFile(h.path, canonUrl));
      if (fileContent) {
        const metadata = parseFullFrontmatter(fileContent);
        if (metadata) hit.metadata = metadata;
      }
    }
    hitsWithMetadata.push(hit);
  }

  return {
    action: "search",
    result: {
      status: "FOUND",
      hits: hitsWithMetadata,
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
  includeMetadata?: boolean,
  section?: string,
): Promise<ActionResult> {
  const startMs = Date.now();

  // Resolve URI to file path. Three cases:
  // 1. klappy:// — strip scheme, append .md (fast path, no index needed)
  // 2. Other URI schemes (kb://, odd://) — look up in index to get real path
  // 3. Raw path — ensure .md extension
  let path = input;

  if (path.startsWith("klappy://")) {
    path = path.replace("klappy://", "");
    if (!path.endsWith(".md")) {
      path = path + ".md";
    }
  } else if (path.includes("://")) {
    // Non-klappy URI (e.g., kb://sources/stringer-widening-the-table)
    // The index knows the real file path for each URI, including suffixes
    // like .surface.md or .full.md that can't be guessed from the URI alone.
    const index = await fetcher.getIndex(canonUrl);
    const entry = index.entries.find((e) => e.uri === input);
    if (entry) {
      path = entry.path;
    } else {
      // Fallback: strip scheme and try as path with .md.
      // odd:// URIs map to the odd/ directory (odd://x → odd/x.md),
      // matching the local docFetch.js safeSubpath("odd", p) behaviour.
      if (path.startsWith("odd://")) {
        path = "odd/" + path.slice("odd://".length);
      } else {
        path = path.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
      }
      if (!path.endsWith(".md")) {
        path = path + ".md";
      }
    }
  } else {
    if (!path.endsWith(".md")) {
      path = path + ".md";
    }
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

  // Section extraction: return only the requested ## section
  if (section) {
    const sectionResult = extractSection(content, section);
    if (!sectionResult.found) {
      return {
        action: "get",
        result: {
          error: sectionResult.error,
          path,
          requested_section: section,
          available_sections: sectionResult.available_sections,
        },
        state: updatedState,
        assistant_text: `Section "${section}" not found in \`${input}\`. Available sections: ${(sectionResult.available_sections || []).map((s) => `"${s}"`).join(", ") || "(none)"}`,
        debug: { duration_ms: Date.now() - startMs, generated_at: new Date().toISOString() },
      };
    }

    const sectionContent = sectionResult.content!;
    const result: Record<string, unknown> = {
      path,
      section,
      content: sectionContent,
      content_hash: hashString(sectionContent),
    };

    if (includeMetadata) {
      const metadata = parseFullFrontmatter(content);
      if (metadata) result.metadata = metadata;
    }

    return {
      action: "get",
      result,
      state: updatedState,
      assistant_text: sectionContent,
      debug: { duration_ms: Date.now() - startMs, generated_at: new Date().toISOString() },
    };
  }

  const result: Record<string, unknown> = { path, content, content_hash: hashString(content) };

  // When include_metadata is requested, parse and attach full frontmatter
  if (includeMetadata) {
    const metadata = parseFullFrontmatter(content);
    if (metadata) result.metadata = metadata;
  }

  return {
    action: "get",
    result,
    state: updatedState,
    assistant_text: content,
    debug: { duration_ms: Date.now() - startMs, generated_at: new Date().toISOString() },
  };
}

function runVersion(env: Env): ActionResult {
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

async function runCleanupStorage(
  fetcher: ZipBaselineFetcher,
  canonUrl?: string,
): Promise<ActionResult> {
  await fetcher.invalidateCache(canonUrl);
  // Also clear the in-memory BM25 index
  cachedBM25Index = null;
  cachedBM25Entries = null;
  cachedEncodingTypes = null;
  cachedEncodingTypesCanonUrl = undefined;
  cachedChallengeTypes = null;
  cachedChallengeTypesCanonUrl = undefined;
  cachedBasePrerequisites = null;
  cachedBasePrerequisitesCanonUrl = undefined;
  cachedNormativeVocabulary = null;
  cachedNormativeVocabularyCanonUrl = undefined;
  cachedStakesCalibration = null;
  cachedStakesCalibrationCanonUrl = undefined;

  return {
    action: "cleanup_storage",
    result: { success: true, canon_url: canonUrl },
    assistant_text:
      "Storage cleaned up. Note: this is storage hygiene only. " +
      "Content-addressed caching ensures correct content is served automatically " +
      "when the baseline changes — no manual cleanup is required for correctness.",
    debug: { generated_at: new Date().toISOString() },
  };
}

// Kept for backward-compat: old librarian using scoreEntries
async function runLibrarian(
  message: string,
  fetcher: ZipBaselineFetcher,
  canonUrl?: string,
  state?: OddkitState,
): Promise<ActionResult> {
  // Delegate to search (BM25) for better results
  return runSearch(message, fetcher, canonUrl, state);
}

async function runValidate(message: string, state?: OddkitState): Promise<ActionResult> {
  const artifactPatterns = /\b(\w+\.(png|jpg|jpeg|gif|mp4|mov|pdf|log|txt))\b/gi;
  const artifacts = [...message.matchAll(artifactPatterns)].map((m) => m[1]);
  const hasScreenshot = artifacts.some((a) => /\.(png|jpg|jpeg|gif)$/i.test(a));
  const hasVideo = artifacts.some((a) => /\.(mp4|mov)$/i.test(a));
  const gaps: string[] = [];
  if (!hasScreenshot && !hasVideo) gaps.push("visual proof (screenshot or recording)");

  // Artifact provenance gate: when completion claims mention finalizing work,
  // check for session capture, change summary, and version tracking
  const isFinalization = /\b(commit|pr|pull request|merge|ship|deploy|release|publish|finalize|submit|deliver)\b/i.test(message);
  if (isFinalization) {
    const hasJournal = /\b(journal|ledger|oldc|session|capture)/i.test(message);
    const hasChangeSummary = /\b(changelog|change\s*log|summary|what changed|release notes)/i.test(message);
    const hasVersion = /\b(version|bump|semver|revision)/i.test(message);
    if (!hasJournal) gaps.push("session capture (OLDC+H — what was observed, learned, decided, constrained)");
    if (!hasChangeSummary) gaps.push("change summary (what changed and why)");
    if (!hasVersion) gaps.push("version or revision tracking (if applicable to this project)");
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
  options?: { sort_by?: string; limit?: number; offset?: number; filter_epoch?: string },
): Promise<ActionResult> {
  const startMs = Date.now();
  const index = await fetcher.getIndex(canonUrl);
  const { sort_by, limit: rawLimit, offset: rawOffset, filter_epoch } = options || {};
  const effectiveLimit = Math.min(Math.max(rawLimit || 10, 1), 500);
  const effectiveOffset = Math.max(rawOffset || 0, 0);

  const byTag: Record<string, IndexEntry[]> = {};
  for (const entry of index.entries) {
    for (const tag of entry.tags || ["other"]) {
      if (!byTag[tag]) byTag[tag] = [];
      byTag[tag].push(entry);
    }
  }

  const startHere = index.entries
    .filter(
      (e) =>
        e.path.includes("QUICKSTART") ||
        e.path.includes("README") ||
        e.title.toLowerCase().includes("getting started"),
    )
    .slice(0, 3);

  const dod = index.entries.find((e) => e.path.toLowerCase().includes("definition-of-done"));

  const topTags = Object.entries(byTag)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 5);

  // Build articles list when sort_by is provided
  let articles: Array<{ path: string; uri: string; title: string; metadata: Record<string, unknown> }> | undefined;
  let totalCandidates = 0;
  if (sort_by === "date" || sort_by === "path") {
    let candidates = sort_by === "date"
      ? index.entries.filter((e) => e.frontmatter)
      : [...index.entries]; // "path" includes ALL entries, even without frontmatter

    // Server-side epoch filter — deterministic, cheap, correct
    if (filter_epoch) {
      candidates = candidates.filter(
        (e) => e.frontmatter && String((e.frontmatter as Record<string, unknown>).epoch) === filter_epoch,
      );
    }

    if (sort_by === "date") {
      // Server-side date sort — deterministic, cheap, correct
      candidates.sort((a, b) => {
        const da = String((a.frontmatter as Record<string, unknown>)?.date ?? "");
        const db = String((b.frontmatter as Record<string, unknown>)?.date ?? "");
        if (db && !da) return 1; // docs without dates sort last
        if (da && !db) return -1;
        return db.localeCompare(da); // newest first
      });
    } else {
      // Alphabetical by path
      candidates.sort((a, b) => (a.path || "").localeCompare(b.path || ""));
    }

    totalCandidates = candidates.length;
    articles = candidates.slice(effectiveOffset, effectiveOffset + effectiveLimit).map((e) => ({
      path: e.path,
      uri: e.uri,
      title: ((e.frontmatter as Record<string, unknown>)?.title as string) || e.title,
      metadata: (e.frontmatter as Record<string, unknown>) || {},
    }));
  }

  const assistantTextParts = [
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
    ...topTags.map(
      ([tag, entries]) =>
        `- ${tag} (${entries.length}): ${entries
          .slice(0, 2)
          .map((e) => e.title)
          .join(", ")}`,
    ),
  ];

  // Append articles listing to assistant_text when present
  if (articles && articles.length > 0) {
    assistantTextParts.push(
      ``,
      `${sort_by === "path" ? "All documents" : "Recent articles"}${filter_epoch ? ` (${filter_epoch})` : ""}:`,
      ...articles.map((a) => {
        const date = (a.metadata.date as string) || "no date";
        return `- \`${a.path}\` — ${a.title || "Untitled"} (${date})`;
      }),
    );
  }

  const assistantText = assistantTextParts.filter(Boolean).join("\n").trim();

  const result: Record<string, unknown> = {
    total: index.stats.total,
    canon: index.stats.canon,
    baseline: index.stats.baseline,
    categories: Object.keys(byTag),
    start_here: startHere.map((e) => e.path),
  };

  // Include articles array only when sort_by is provided
  if (articles) {
    result.articles = articles;
    result.pagination = {
      offset: effectiveOffset,
      limit: effectiveLimit,
      total_candidates: totalCandidates,
      has_more: (effectiveOffset + effectiveLimit) < totalCandidates,
    };
  }

  return {
    action: "catalog",
    result,
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
): Promise<ActionResult> {
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
  ]
    .join("\n")
    .trim();

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

/**
 * Extract the creed from orientation.md content.
 * Returns array of creed lines, or null if not found.
 *
 * NOTE: Canonical implementation is src/utils/creed.js (Node.js).
 * This is a Worker-runtime copy. If parsing rules change, update both.
 */
function extractCreedFromContent(content: string): string[] | null {
  const lines = content.split("\n");
  const startIdx = lines.findIndex((l) => /^##\s+The Creed/.test(l));
  if (startIdx === -1) return null;
  const creedLines: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    const trimmed = lines[i].trim();
    if (
      trimmed &&
      !trimmed.startsWith(">") &&
      !trimmed.startsWith("#") &&
      !trimmed.startsWith("<!--") &&
      !/^-{3,}$/.test(trimmed)
    ) {
      creedLines.push(trimmed);
    }
  }
  return creedLines.length > 0 ? creedLines : null;
}

async function runOrientAction(
  input: string,
  fetcher: ZipBaselineFetcher,
  canonUrl?: string,
  state?: OddkitState,
): Promise<ActionResult> {
  const startMs = Date.now();
  const { mode, confidence } = detectMode(input);
  const index = await fetcher.getIndex(canonUrl);
  const results = scoreEntries(index.entries, input).slice(0, 3);

  // Read creed from baseline (always included in orient response)
  let creed: string[] | null = null;
  try {
    const orientContent = await fetcher.getFile("canon/values/orientation.md", canonUrl);
    if (orientContent) {
      creed = extractCreedFromContent(orientContent);
    }
  } catch {
    // Creed is best-effort; orient works without it
  }

  const canonRefs: Array<{ path: string; quote: string }> = [];
  for (const entry of results) {
    const content = await fetcher.getFile(entry.path, canonUrl);
    if (content) {
      const stripped = content.replace(/^---[\s\S]*?---\n/, "");
      const lines = stripped.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
      canonRefs.push({
        path: `${entry.path}#${entry.title}`,
        quote: lines.slice(0, 2).join(" ").slice(0, 150),
      });
    }
  }

  const assumptions: string[] = [];
  for (const s of input.split(/[.!?\n]+/).filter((s) => s.trim().length > 5)) {
    if (
      /\b(is|are|will|should|must|always|never|obviously|clearly)\b/i.test(s) &&
      !s.endsWith("?")
    ) {
      assumptions.push(s.trim());
    }
  }

  const questions: string[] = [];
  if (mode === "exploration") {
    questions.push(
      "What specific problem are you trying to solve?",
      "What constraints or boundaries apply here?",
      "What would success look like?",
    );
  } else if (mode === "planning") {
    questions.push(
      "What decisions have been locked vs. still open?",
      "What are the irreversible aspects of this plan?",
      "What evidence supports this approach over alternatives?",
    );
  } else {
    questions.push(
      "Has the plan been validated against constraints?",
      "What does the definition of done look like?",
      "What artifacts will demonstrate completion?",
    );
  }

  // Update state
  const updatedState = state ? initState(state) : undefined;
  if (updatedState) {
    updatedState.phase = mode as OddkitState["phase"];
    updatedState.unresolved = [...updatedState.unresolved, ...assumptions.slice(0, 3)];
    addCanonRefs(
      updatedState,
      canonRefs.map((r) => r.path),
    );
  }

  const lines: string[] = [];
  if (creed && creed.length > 0) {
    lines.push("The Creed:");
    for (const c of creed) lines.push(`  ${c}`);
    lines.push("");
  }
  lines.push(`Orientation: ${mode} mode (${confidence} confidence)`, "");
  lines.push("Proactive posture: Track OLDC+H continuously throughout this session. Encode what the user shares and what you do at every exchange. Resurface the creed when confidence outpaces evidence. Persist to project storage at natural breakpoints. ARTIFACT PROVENANCE: When work produces durable artifacts, capture what happened (journal), what changed (changelog/summary), and what version (if applicable). Do this at every milestone, before every review, and before finalizing — not at session end. Do not wait to be asked.", "");
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
    result: {
      status: "ORIENTED",
      creed: creed || null,
      current_mode: mode,
      mode_confidence: confidence,
      assumptions,
      suggested_questions: questions,
      canon_refs: canonRefs,
    },
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
): Promise<ActionResult> {
  const startMs = Date.now();

  // 1. Load all governance
  const types = await discoverChallengeTypes(fetcher, canonUrl);
  const basePrereqs = await fetchBasePrerequisites(fetcher, canonUrl);
  const normVocab = await fetchNormativeVocabulary(fetcher, canonUrl);
  const calibrations = await fetchStakesCalibration(fetcher, canonUrl);

  // 2. Resolve mode and calibration
  const mode = modeHint || "planning";
  const calibration =
    calibrations.find((c) => c.mode === mode) ||
    calibrations.find((c) => c.mode === "planning") ||
    calibrations[0] || {
      mode: "planning", questionTiers: ["baseline", "elevated"],
      strictness: "required" as const, reframings: "all" as const,
    };

  // 3. Multi-match detection
  let matchedTypes: ChallengeTypeDef[] = types.filter(
    (t) => t.triggerRegex && t.triggerRegex.test(input),
  );
  if (matchedTypes.length === 0) {
    const fallbackType = types.find((t) => t.fallback) || types[0];
    if (fallbackType) matchedTypes = [fallbackType];
  }

  // 4. VOICE-DUMP INVARIANT: if calibration says no question tiers, suppress entire output.
  //    This is load-bearing — some modes exist for raw thought capture and pressure-testing
  //    at that stage damages the mode. Do not "helpfully" surface a reduced set.
  if (calibration.questionTiers.length === 0) {
    const primary = matchedTypes[0]?.slug || "observation";
    return {
      action: "challenge",
      result: {
        status: "SUPPRESSED",
        mode_used: mode,
        matched_types: matchedTypes.map((t) => t.slug),
        claim_type: primary,  // backward-compat alias
        tensions: [],
        missing_prerequisites: [],
        challenges: [],
        suggested_reframings: [],
        canon_constraints: [],
        governance: matchedTypes.map((t) => ({
          slug: t.slug,
          name: t.name,
          description: t.blockquote,
        })),
      },
      state: state ? initState(state) : undefined,
      assistant_text:
        `Challenge suppressed (mode: ${mode}). This mode exists for raw capture; ` +
        `pressure-testing would damage the mode's function. Resume challenge at a later stage.`,
      debug: { duration_ms: Date.now() - startMs, generated_at: new Date().toISOString() },
    };
  }

  // 5. Aggregate across matched types
  const aggregatedQuestions: Array<{ question: string; tier: string }> = [];
  const aggregatedOverlays: PrereqOverlay[] = [];
  const aggregatedReframings: string[] = [];
  for (const t of matchedTypes) {
    aggregatedQuestions.push(...t.questions);
    aggregatedOverlays.push(...t.prereqOverlays);
    aggregatedReframings.push(...t.reframings);
  }

  // 6. Filter questions by stakes tier, dedupe by string
  const filteredQuestions = aggregatedQuestions
    .filter((q) => calibration.questionTiers.includes(q.tier))
    .map((q) => q.question);
  const challenges = Array.from(new Set(filteredQuestions));

  // 7. Merge base + type overlay prerequisites, dedupe by name, test each against input
  const allPrereqs = [...basePrereqs, ...aggregatedOverlays];
  const uniquePrereqs = Array.from(
    new Map(allPrereqs.map((p) => [p.name, p])).values(),
  );

  const missing: string[] = [];
  for (const prereq of uniquePrereqs) {
    if (prereq.keywords.length === 0) {
      // No quoted keywords — check is descriptive-only, cannot mechanically test. Skip.
      continue;
    }
    const matched = prereq.keywords.some((k) =>
      new RegExp("\\b" + k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i").test(input),
    );
    if (!matched) {
      const typeName = matchedTypes[0]?.name || "claim";
      let gap = prereq.gapMessage.replace(/\{name\}/g, typeName.toLowerCase());
      if (calibration.strictness === "optional") gap = `Advisory: ${gap}`;
      missing.push(gap);
    }
  }

  // 8. Dedupe and filter reframings
  const dedupedReframings = Array.from(new Set(aggregatedReframings));
  let reframings: string[];
  switch (calibration.reframings) {
    case "none":
      reframings = [];
      break;
    case "first_1":
      // Surface at most one reframing total
      reframings = dedupedReframings.slice(0, 1);
      break;
    case "all":
    case "all_plus_block":
    default:
      reframings = dedupedReframings;
  }

  // 9. Retrieve canon constraints (same BM25 path as before)
  const index = await fetcher.getIndex(canonUrl);
  const results = scoreEntries(index.entries, `constraints challenges risks ${input}`).slice(0, 4);

  const canonConstraints: Array<{ citation: string; quote: string }> = [];
  const tensions: Array<{ type: string; message: string }> = [];

  for (const entry of results) {
    const content = await fetcher.getFile(entry.path, canonUrl);
    if (!content) continue;
    const stripped = content.replace(/^---[\s\S]*?---\n/, "");
    const lines = stripped.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
    const excerpt = lines.slice(0, 2).join(" ").slice(0, 150);
    canonConstraints.push({ citation: `${entry.path}#${entry.title}`, quote: excerpt });

    // Apply normative vocabulary regexes
    let foundMatch: string | null = null;
    if (normVocab.rfc2119Regex) {
      const m = excerpt.match(normVocab.rfc2119Regex);
      if (m) foundMatch = m[0];
    }
    if (!foundMatch && normVocab.architecturalRegex) {
      const m = excerpt.match(normVocab.architecturalRegex);
      if (m) foundMatch = m[0];
    }
    if (foundMatch) {
      const directiveType = normVocab.directiveLookup.get(foundMatch.toLowerCase()) || "directive";
      tensions.push({
        type: directiveType,
        message: `Canon ${directiveType} (${foundMatch}) found in ${entry.path}`,
      });
    }
  }

  // 10. Update state
  const updatedState = state ? initState(state) : undefined;
  if (updatedState && missing.length > 0) {
    updatedState.unresolved = [...updatedState.unresolved, ...missing];
  }

  // 11. Build human-readable assistant_text (preserve existing format roughly)
  const primarySlug = matchedTypes[0]?.slug || "observation";
  const primaryName = matchedTypes[0]?.name || "Observation";
  const typesLabel =
    matchedTypes.length > 1 ? `${primaryName} +${matchedTypes.length - 1} more` : primaryName;
  const lines = [`Challenge (${typesLabel}, mode: ${mode}):`, ""];
  if (tensions.length > 0) {
    lines.push("Tensions found:");
    for (const t of tensions) lines.push(`  - [${t.type}] ${t.message}`);
    lines.push("");
  }
  if (missing.length > 0) {
    lines.push("Missing prerequisites:");
    for (const m of missing) lines.push(`  - ${m}`);
    lines.push("");
  }
  if (challenges.length > 0) {
    lines.push("Questions to address:");
    for (const c of challenges) lines.push(`  - ${c}`);
    lines.push("");
  }
  if (reframings.length > 0) {
    lines.push("Suggested reframings:");
    for (const r of reframings) lines.push(`  - ${r}`);
    lines.push("");
  }
  if (calibration.reframings === "all_plus_block" && reframings.length > 0) {
    lines.push("⚠ Block-until-addressed: this claim should not proceed until reframings are explicitly addressed or declined.");
    lines.push("");
  }
  if (canonConstraints.length > 0) {
    lines.push("Canon constraints:");
    for (const c of canonConstraints) {
      lines.push(`  > ${c.quote}`);
      lines.push(`  — ${c.citation}`);
      lines.push("");
    }
  }

  return {
    action: "challenge",
    result: {
      status: "CHALLENGED",
      mode_used: mode,
      matched_types: matchedTypes.map((t) => t.slug),
      claim_type: primarySlug,  // backward-compat alias — first matched slug
      tensions,
      missing_prerequisites: missing,
      challenges,
      suggested_reframings: reframings,
      canon_constraints: canonConstraints,
      governance: matchedTypes.map((t) => ({
        slug: t.slug,
        name: t.name,
        description: t.blockquote,
      })),
    },
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
): Promise<ActionResult> {
  const startMs = Date.now();
  const transition = detectTransition(input);
  const fullInput = context ? `${input}\n${context}` : input;

  interface Prereq {
    id: string;
    description: string;
    required: boolean;
  }
  const prereqs: Prereq[] = [];
  if (transition.from === "exploration" && transition.to === "planning") {
    prereqs.push({
      id: "problem_defined",
      description: "Problem statement is clearly defined",
      required: true,
    });
    prereqs.push({
      id: "constraints_reviewed",
      description: "Relevant constraints have been reviewed",
      required: true,
    });
  } else if (transition.from === "planning" && transition.to === "execution") {
    prereqs.push({
      id: "decisions_locked",
      description: "Key decisions are locked",
      required: true,
    });
    prereqs.push({ id: "dod_defined", description: "Definition of done is clear", required: true });
    prereqs.push({
      id: "irreversibility_assessed",
      description: "Irreversible aspects identified",
      required: true,
    });
    prereqs.push({
      id: "constraints_satisfied",
      description: "All MUST constraints are addressable",
      required: true,
    });
  } else if (transition.to === "completion") {
    prereqs.push({ id: "dod_met", description: "DoD criteria met with evidence", required: true });
    prereqs.push({
      id: "artifacts_present",
      description: "Required artifacts present",
      required: true,
    });
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
  const results = scoreEntries(index.entries, `transition boundary deceleration ${input}`).slice(
    0,
    3,
  );
  const canonRefs: Array<{ path: string; quote: string }> = [];
  for (const entry of results) {
    const content = await fetcher.getFile(entry.path, canonUrl);
    if (content) {
      const stripped = content.replace(/^---[\s\S]*?---\n/, "");
      const lines2 = stripped.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
      canonRefs.push({
        path: `${entry.path}#${entry.title}`,
        quote: lines2.slice(0, 2).join(" ").slice(0, 150),
      });
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
  lines.push(
    `Prerequisites: ${met.length}/${prereqs.filter((p) => p.required).length} required met`,
    "",
  );
  if (unmet.length > 0) {
    lines.push("Unmet (required):");
    for (const u of unmet) lines.push(`  - ${u}`);
    lines.push("");
  }
  if (met.length > 0) {
    lines.push("Met:");
    for (const m of met) lines.push(`  + ${m}`);
    lines.push("");
  }
  if (canonRefs.length > 0) {
    lines.push("Relevant canon:");
    for (const r of canonRefs) {
      lines.push(`  > ${r.quote}`);
      lines.push(`  — ${r.path}`);
      lines.push("");
    }
  }

  return {
    action: "gate",
    result: {
      status: gateStatus,
      transition,
      prerequisites: {
        met,
        unmet,
        unknown,
        required_met: met.length,
        required_total: prereqs.filter((p) => p.required).length,
      },
    },
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
): Promise<ActionResult> {
  const startMs = Date.now();
  // Governance: input generates artifacts; context only informs quality scoring.
  // See: klappy://odd/encoding-types/how-to-write-encoding-types#context-vs-input
  // Do not pass fullInput to parsers — that would create separate artifacts
  // for each context paragraph instead of letting context inform scoring.

  const types = await discoverEncodingTypes(fetcher, canonUrl);
  const structured = isStructuredInput(input);
  const artifacts = structured
    ? parseStructuredInput(input, types)
    : parseUnstructuredInput(input, types);

  // Score each artifact using its type's quality criteria.
  // When context is provided, append it to the artifact's body for scoring
  // so background information (rationale, alternatives, evidence) counts
  // toward the artifact's quality without becoming separate artifacts.
  const scoredArtifacts = artifacts.map((a) => {
    const typeDef = types.find((t) => t.letter === a.type);
    const criteria = typeDef ? typeDef.qualityCriteria : [];
    const scoringText = context ? `${a.body}\n${context}` : undefined;
    const quality = scoreArtifactQuality(a, criteria, scoringText);
    return { title: a.title, type: a.type, typeName: a.typeName, content: a.body, fields: a.fields, quality };
  });

  // Update state — track all encoded type letters
  const updatedState = state ? initState(state) : undefined;
  if (updatedState) {
    for (const a of artifacts) {
      updatedState.decisions_encoded.push(`${a.type}:${a.title}`);
    }
  }

  // Build assistant_text as markdown with per-artifact sections
  const lines: string[] = [
    `## Encoded ${scoredArtifacts.length} artifact${scoredArtifacts.length !== 1 ? "s" : ""}`,
    "",
  ];
  for (const a of scoredArtifacts) {
    lines.push(`### [${a.type}] ${a.typeName}: ${a.title}`);
    lines.push(`**Quality:** ${a.quality.level} (${a.quality.score}/${a.quality.maxScore})`);
    lines.push("");
    lines.push(a.content);
    lines.push("");
    if (a.quality.gaps.length > 0) {
      lines.push("**Gaps:**");
      for (const g of a.quality.gaps) lines.push(`- ${g}`);
      lines.push("");
    }
    if (a.quality.suggestions.length > 0) {
      lines.push("**Suggestions:**");
      for (const s of a.quality.suggestions) lines.push(`- ${s}`);
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("**Encoding types (governance):**");
  for (const t of types) {
    lines.push(`- **${t.letter}** — ${t.name}`);
  }

  return {
    action: "encode",
    result: {
      status: "ENCODED",
      artifacts: scoredArtifacts,
      governance: types.map((t) => ({ letter: t.letter, name: t.name })),
      persist_required: true,
      next_action: "Save these artifacts to storage. Encode does NOT persist.",
    },
    state: updatedState,
    assistant_text: lines.join("\n").trim(),
    debug: { duration_ms: Date.now() - startMs, generated_at: new Date().toISOString() },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Unified handler — single entry point for the consolidated `oddkit` tool
// ──────────────────────────────────────────────────────────────────────────────

const VALID_ACTIONS = [
  "orient",
  "challenge",
  "gate",
  "encode",
  "search",
  "get",
  "catalog",
  "validate",
  "preflight",
  "version",
  "cleanup_storage",
] as const;

export async function handleUnifiedAction(params: UnifiedParams): Promise<OddkitEnvelope> {
  const { action, input, context, mode, canon_url, include_metadata, section, sort_by, limit, offset, filter_epoch, state, env, tracer } = params;

  if (!VALID_ACTIONS.includes(action as (typeof VALID_ACTIONS)[number])) {
    return {
      action: "error",
      result: { error: `Unknown action: ${action}. Valid: ${VALID_ACTIONS.join(", ")}` },
      server_time: new Date().toISOString(),
      assistant_text: `Unknown action: ${action}. Valid actions: ${VALID_ACTIONS.join(", ")}`,
      debug: { generated_at: new Date().toISOString() },
    };
  }

  const fetcher = new ZipBaselineFetcher(env, tracer);

  try {
    const actionStart = performance.now();
    let result: ActionResult;

    switch (action) {
      case "orient":
        result = await runOrientAction(input, fetcher, canon_url, state);
        break;
      case "challenge":
        result = await runChallengeAction(input, mode, fetcher, canon_url, state);
        break;
      case "gate":
        result = await runGateAction(input, context, fetcher, canon_url, state);
        break;
      case "encode":
        result = await runEncodeAction(input, context, fetcher, canon_url, state);
        break;
      case "search":
        result = await runSearch(input, fetcher, canon_url, state, include_metadata);
        break;
      case "get":
        result = await runGet(input, fetcher, canon_url, state, include_metadata, section);
        break;
      case "catalog":
        result = await runCatalog(fetcher, canon_url, state, { sort_by, limit, offset, filter_epoch });
        break;
      case "validate":
        result = await runValidate(input, state);
        break;
      case "preflight":
        result = await runPreflight(input, fetcher, canon_url, state);
        break;
      case "version":
        result = runVersion(env);
        break;
      case "cleanup_storage":
        result = await runCleanupStorage(fetcher, canon_url);
        break;
      default:
        result = await runSearch(input, fetcher, canon_url, state);
    }

    // Inject trace into debug envelope (E0008.1)
    if (tracer) {
      tracer.addSpan(`action:${action}`, performance.now() - actionStart);
      result.debug = {
        ...result.debug,
        trace: tracer.toJSON(),
      };
    }

    // Put the clock in the room (E0008.2) — one place, every response
    return { ...result, server_time: new Date().toISOString() };
  } catch (error) {
    return {
      action: "error",
      result: { error: error instanceof Error ? error.message : "Unknown error" },
      server_time: new Date().toISOString(),
      state: state ? initState(state) : undefined,
      assistant_text: `Error in ${action}: ${error instanceof Error ? error.message : "Unknown error"}`,
      debug: {
        canon_url,
        baseline_url: env.BASELINE_URL,
        generated_at: new Date().toISOString(),
        ...(tracer ? { trace: tracer.toJSON() } : {}),
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

interface OrientOptions {
  input: string;
  env: Env;
  canonUrl?: string;
}
interface ChallengeOptions {
  input: string;
  mode?: string;
  env: Env;
  canonUrl?: string;
}
interface GateOptions {
  input: string;
  context?: string;
  env: Env;
  canonUrl?: string;
}
interface EncodeOptions {
  input: string;
  context?: string;
  env: Env;
  canonUrl?: string;
}

/** @deprecated Use handleUnifiedAction({ action: "orient", ... }) */
export async function runOrientActionCompat(options: OrientOptions): Promise<OddkitEnvelope> {
  return handleUnifiedAction({
    action: "orient",
    input: options.input,
    canon_url: options.canonUrl,
    env: options.env,
  });
}

/** @deprecated Use handleUnifiedAction({ action: "challenge", ... }) */
export async function runChallengeActionCompat(options: ChallengeOptions): Promise<OddkitEnvelope> {
  return handleUnifiedAction({
    action: "challenge",
    input: options.input,
    mode: options.mode,
    canon_url: options.canonUrl,
    env: options.env,
  });
}

/** @deprecated Use handleUnifiedAction({ action: "gate", ... }) */
export async function runGateActionCompat(options: GateOptions): Promise<OddkitEnvelope> {
  return handleUnifiedAction({
    action: "gate",
    input: options.input,
    context: options.context,
    canon_url: options.canonUrl,
    env: options.env,
  });
}

/** @deprecated Use handleUnifiedAction({ action: "encode", ... }) */
export async function runEncodeActionCompat(options: EncodeOptions): Promise<OddkitEnvelope> {
  return handleUnifiedAction({
    action: "encode",
    input: options.input,
    context: options.context,
    canon_url: options.canonUrl,
    env: options.env,
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Utility
// ──────────────────────────────────────────────────────────────────────────────

function hashString(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}
