/**
 * Orchestration logic for oddkit MCP Worker
 *
 * Uses KnowledgeBaseFetcher for tiered caching of baseline repos.
 * Supports canon repo overrides with klappy.dev fallback.
 *
 * v2: Unified handler with action routing, BM25 search, state threading,
 * and consistent response envelope.
 */

import {
  KnowledgeBaseFetcher,
  extractSection,
  parseFullFrontmatter,
  type Env,
  type BaselineIndex,
  type IndexEntry,
  type SectionResult,
} from "./zip-baseline-fetcher";
import { buildBM25Index, searchBM25, tokenize, type BM25Index } from "./bm25";
import { parseTableRow } from "./markdown-utils";
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
    knowledge_base_url?: string;
    canon_commit?: string;
    generated_at?: string;
    search_index_size?: number;
    duration_ms?: number;
    [key: string]: unknown;
  };
}

/** Internal type — handlers return this, handleUnifiedAction stamps server_time */
type ActionResult = Omit<OddkitEnvelope, "server_time">;

// Governance-driven encoding types. Trigger-word classification is stemmed
// phrase-subset matching per klappy://canon/principles/vodka-architecture
// (fit the matcher to the problem) — same D5 shape applied to challenge
// prereqs in 0.21.0 and gate prereqs in 0.20.0. triggerWords kept for
// debugging only; stemmedPhrases is the parse product the runtime evaluates
// against. Each inner array is the ordered stem sequence of a single
// trigger word or phrase; a type matches an input when ALL stems of at
// least one phrase are present in the input's stem set. This preserves
// phrase-level semantics (`committed to`, `going with`, `must not`,
// `next step`, `follow up`, `blocked by`, `turns out`) so common function
// words (`to`, `with`, `by`, `up`, `out`, `not`) do not become standalone
// match triggers on every English paragraph.
interface EncodingTypeDef {
  letter: string;
  name: string;
  triggerWords: string[];
  stemmedPhrases: string[][];
  qualityCriteria: Array<{ criterion: string; check: string; gapMessage: string }>;
}

interface ParsedArtifact {
  type: string;
  typeName: string;
  fields: string[];
  title: string;
  body: string;
  // DOLCHEO facet for Open items ([O-open] prefix). Canon-defined variant of
  // letter O — closed Observation is the default; facet "open" marks forward-
  // pointing unresolved threads. See canon/definitions/dolcheo-vocabulary.
  facet?: string;
  // Priority band for Open items, e.g. "P1", "P2.1". Sub-bands allowed.
  priority_band?: string;
}

// D9 / klappy://canon/principles/cache-fetches-and-parses — no module-level
// cache on the parse product. fetcher.getFile / fetcher.getIndex already cache
// the canon read (Module Memory → Cache API → R2, 5-min TTL). Re-running the
// parse loop per request is sub-millisecond derivation work, not worth the
// plumbing tax of a keyed cache. Same pattern challenge (0.21.0) and gate
// (0.20.0) already applied.

// Governance-driven challenge types (E0008 — mirrors encode pattern from PR #96)
interface ChallengeTypeDef {
  slug: string;
  name: string;
  blockquote: string;
  triggerWords: string[];
  detectionText: string; // triggerWords + blockquote, fed to BM25 indexer
  questions: Array<{ question: string; tier: string }>;
  prerequisiteOverlays: Array<
    {
      prerequisite: string;
      check: string;
      gapMessage: string;
    } & PrereqMatchVocab
  >;
  reframings: string[];
  fallback: boolean;
}

interface BasePrerequisiteCore {
  prerequisite: string;
  check: string;
  gapMessage: string;
}

// BasePrerequisite shares the PrereqMatchVocab shape (stemmedTokens + 4
// structural-test flags) with ChallengeTypeDef.prerequisiteOverlays[] via
// intersection — defined as `& PrereqMatchVocab` rather than re-listing the
// fields, so future field additions to the shared shape propagate
// automatically. Per Bugbot finding on PR #120 (low severity).
type BasePrerequisite = BasePrerequisiteCore & PrereqMatchVocab;

/** Shared shape for the runtime match vocabulary attached to challenge
 *  prereqs. Keeps the per-type and base-prereq structs in sync (DRY). */
interface PrereqMatchVocab {
  stemmedTokens: Set<string>;
  hasURLCheck: boolean;
  hasNumericCheck: boolean;
  hasProperNounCheck: boolean;
  hasCitationCheck: boolean;
}

// Gate governance types — P1.3.2 (0.20.0). Consumed by runGateAction via
// fetchGateTransitions and fetchGatePrerequisites. Both read from canon
// at runtime with a hardcoded minimal vocabulary as the fallback tier.
// See canon/constraints/core-governance-baseline §Canon-Only — odd/gate/
// is explicitly canon-only with "structural prereqs" as the minimal tier.
interface TransitionDef {
  /** Canon key, e.g. "planning-to-execution". Used as BM25 doc id and for tiebreaker lookup. */
  key: string;
  /** The mode being exited. */
  from: string;
  /** The mode being entered. */
  to: string;
  /** Prerequisite ids that must be satisfied. Resolved against GatePrerequisite[]. */
  prereqIds: string[];
  /** Comma-separated detection phrases concatenated into one string, fed to buildBM25Index. */
  detectionText: string;
  /** Canon table row index (0-based). Deterministic tiebreaker for BM25 score ties. */
  rowOrder: number;
}

interface GatePrerequisite {
  /** Prereq id, e.g. "problem_defined". Referenced by TransitionDef.prereqIds. */
  id: string;
  /** Raw comma-separated check vocabulary from canon, preserved for debugging/introspection. */
  check: string;
  /** Surfaced to callers when the prereq fails. */
  gapMessage: string;
  /** Precomputed stems of the check vocabulary. Populated at parse time in fetchGatePrerequisites;
   *  reused across requests (cache fetches and parses, not microsecond derivations — per PRD D9).
   *  Prereq evaluation is stemmed set intersection: inputStems.intersect(prereq.stemmedTokens) non-empty → pass. */
  stemmedTokens: Set<string>;
}

interface NormativeVocabulary {
  caseSensitiveRegex: RegExp | null;
  caseInsensitiveRegex: RegExp | null;
  directiveTypes: Map<string, string>;
  /** Stop words for user-input matching against per-type detection text.
   *  Sourced from the `## Detection Noise` section of normative-vocabulary.md.
   *  Empty Set = no filtering (server falls back to BM25 IDF only). Modal
   *  verbs and negation are deliberately absent from canon's default list
   *  because they are signal for strong-claim, proposal, and assumption types. */
  stopWords: Set<string>;
}

interface StakesModeConfig {
  questionTiers: string[];
  prerequisiteStrictness: string;
  reframingSurfacing: string;
}

interface StakesCalibration {
  byMode: Map<string, StakesModeConfig>;
}

let cachedChallengeTypes: ChallengeTypeDef[] | null = null;
let cachedChallengeTypesKnowledgeBaseUrl: string | undefined = undefined;
let cachedChallengeTypesSource: "knowledge_base" | "minimal" = "minimal";
// Note: challenge's BM25 type-detection index is NOT cached — per
// klappy://canon/principles/cache-fetches-and-parses, rebuilding a BM25
// index over challenge's 6–9-type corpus is a microsecond derivation and
// the plumbing tax (URL-keyed invalidation + cleanup_storage wiring +
// drift risk) costs more than the rebuild. Inline-built at the call site
// in runChallengeAction, same pattern as gate's transition index (0.20.0).
let cachedBasePrerequisites: BasePrerequisite[] | null = null;
let cachedBasePrerequisitesKnowledgeBaseUrl: string | undefined = undefined;
let cachedBasePrerequisitesSource: "knowledge_base" | "minimal" = "minimal";
let cachedNormativeVocabulary: NormativeVocabulary | null = null;
let cachedNormativeVocabularyKnowledgeBaseUrl: string | undefined = undefined;
let cachedNormativeVocabularySource: "knowledge_base" | "minimal" = "minimal";
let cachedStakesCalibration: StakesCalibration | null = null;
let cachedStakesCalibrationKnowledgeBaseUrl: string | undefined = undefined;
let cachedStakesCalibrationSource: "knowledge_base" | "minimal" = "minimal";

// Gate governance caches — P1.3.2 (0.20.0). Parsed governance arrays are
// cached here; BM25 indexes over transitions are built per-request (not
// cached — see PRD D9). GatePrerequisite.stemmedTokens is a parse product
// cached inside each struct, which differs from transitions' inline index:
// cache fetches and parses, not microsecond derivations.
let cachedGateTransitions: TransitionDef[] | null = null;
let cachedGateTransitionsKnowledgeBaseUrl: string | undefined = undefined;
let cachedGateTransitionsSource: "knowledge_base" | "minimal" = "minimal";
let cachedGatePrerequisites: GatePrerequisite[] | null = null;
let cachedGatePrerequisitesKnowledgeBaseUrl: string | undefined = undefined;
let cachedGatePrerequisitesSource: "knowledge_base" | "minimal" = "minimal";

export interface UnifiedParams {
  action: string;
  input: string;
  context?: string;
  mode?: string;
  knowledge_base_url?: string;
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
  knowledgeBaseUrl?: string;
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

// Discover encoding types from canon governance docs.
//
// Governance resolution per canon/constraints/core-governance-baseline:
//   1. Live knowledge-base fetch (preferred) → governance_source: "knowledge_base"
//   2. Minimal hardcoded DOLCHEO fallback     → governance_source: "minimal"
//
// Encoding-types are documented as canon-only (not in the required-baseline
// manifest), so encode has no "bundled" tier. Degradation is soft: the tool
// still encodes, with generic-rather-than-type-specific quality scoring.
// See canon/definitions/dolcheo-vocabulary for the letter registry contract.
async function discoverEncodingTypes(
  fetcher: KnowledgeBaseFetcher,
  knowledgeBaseUrl?: string,
): Promise<{ types: EncodingTypeDef[]; source: "knowledge_base" | "minimal" }> {
  const index = await fetcher.getIndex(knowledgeBaseUrl);
  const typeArticles = index.entries.filter(
    (entry: IndexEntry) => entry.tags?.includes("encoding-type") && entry.path.includes("encoding-types/"),
  );

  const types: EncodingTypeDef[] = [];
  for (const article of typeArticles) {
    try {
      const content = await fetcher.getFile(article.path, knowledgeBaseUrl);
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
      // D5 / klappy://canon/principles/vodka-architecture — classification is
      // stemmed phrase-subset matching, not regex alternation. Each canon
      // trigger word/phrase is parsed once into its ordered stem sequence;
      // runtime tokenizes input once and a type matches when ALL stems of
      // at least one phrase are present. Inflected forms (deciding → decid,
      // realizing → realiz) match their canonical stems without canon having
      // to list each inflection. Stop-word filtering is disabled (empty Set)
      // on both the parse-time and runtime tokenize() calls — canon vocab
      // includes stop-word-adjacent phrases (`going with`, `committed to`,
      // `must not`, `turns out`, `next step`, `blocked by`, `found that`)
      // and dropping them would silently break the strictly-additive
      // invariant, the same failure mode P1.3.3 hit on challenge's
      // `from`-in-source-named vocab. Phrase-level conjunction (all stems
      // of a phrase must match) is the precision floor: without it,
      // ubiquitous function words like `to`/`with`/`by`/`up`/`out`/`not`
      // would become standalone triggers on every English paragraph.
      // Per canon/constraints/release-validation-gate and P1.3.3 C-04.
      const stemmedPhrases: string[][] = [];
      for (const word of triggerWords) {
        const stems = tokenize(word, new Set());
        if (stems.length > 0) stemmedPhrases.push(stems);
      }

      const criteriaSection = content.match(
        /## Quality Criteria[\s\S]*?\| Criterion[\s\S]*?\|[-|\s]+\|\n([\s\S]*?)(?=\n\n|\n##|$)/,
      );
      const qualityCriteria: Array<{ criterion: string; check: string; gapMessage: string }> = [];
      if (criteriaSection) {
        for (const row of criteriaSection[1].split("\n").filter((r: string) => r.includes("|"))) {
          const cols = parseTableRow(row);
          if (cols.length >= 3) {
            qualityCriteria.push({
              criterion: cols[0],
              check: cols[1],
              gapMessage: cols[2].replace(/^"|"$/g, ""),
            });
          }
        }
      }

      types.push({ letter, name, triggerWords, stemmedPhrases, qualityCriteria });
    } catch {
      continue;
    }
  }

  // Deduplicate by letter: per DOLCHEO, both closed Observation and Open share
  // letter "O" (with Open distinguished by facet, not letter). If canon contains
  // multiple `encoding-type`-tagged docs with the same letter (e.g. observation.md
  // and open.md), keep the first one discovered — the letter registry is
  // single-character-per-entry.
  const deduped: EncodingTypeDef[] = [];
  const seen = new Set<string>();
  for (const t of types) {
    if (seen.has(t.letter)) continue;
    seen.add(t.letter);
    deduped.push(t);
  }

  let source: "knowledge_base" | "minimal";
  let resolved: EncodingTypeDef[];
  if (deduped.length > 0) {
    resolved = deduped;
    source = "knowledge_base";
  } else {
    // Minimal DOLCHEO fallback — six letters per canon/definitions/dolcheo-vocabulary.
    // Open is a facet of O, not a separate letter; the prefix parser surfaces
    // it via the [O-open] tag. Upgraded from the pre-DOLCHEO 5-letter OLDC+H.
    const defaults: Array<[string, string, string[]]> = [
      ["D", "Decision",    ["decided", "decision", "chose", "committed to", "going with"]],
      ["O", "Observation", ["observed", "noticed", "found", "measured", "detected"]],
      ["L", "Learning",    ["learned", "realized", "discovered", "turns out", "insight"]],
      ["C", "Constraint",  ["must", "must not", "never", "always", "constraint", "cannot"]],
      ["H", "Handoff",     ["next session", "next step", "todo", "follow up", "blocked by"]],
      ["E", "Encode",      ["encoded", "captured", "crystallized", "persisted", "artifact"]],
    ];
    resolved = defaults.map(([letter, name, words]) => {
      const stemmedPhrases: string[][] = [];
      for (const word of words) {
        const stems = tokenize(word, new Set());
        if (stems.length > 0) stemmedPhrases.push(stems);
      }
      return {
        letter, name, triggerWords: words,
        stemmedPhrases,
        qualityCriteria: [],
      };
    });
    source = "minimal";
  }

  return { types: resolved, source };
}

// ──────────────────────────────────────────────────────────────────────────────
// E0008 — Governance-driven challenge (mirrors encode pattern from PR #96)
// Four discovery/fetch helpers read canon at runtime rather than hardcoding
// claim types, tensions, prerequisites, and mode calibration in source.
// ──────────────────────────────────────────────────────────────────────────────

async function discoverChallengeTypes(
  fetcher: KnowledgeBaseFetcher,
  knowledgeBaseUrl?: string,
): Promise<{ types: ChallengeTypeDef[]; source: "knowledge_base" | "minimal" }> {
  if (cachedChallengeTypes && cachedChallengeTypesKnowledgeBaseUrl === knowledgeBaseUrl) {
    return { types: cachedChallengeTypes, source: cachedChallengeTypesSource };
  }

  const index = await fetcher.getIndex(knowledgeBaseUrl);
  const typeArticles = index.entries.filter(
    (entry: IndexEntry) =>
      entry.tags?.includes("challenge-type") && entry.path.includes("challenge-types/"),
  );

  const types: ChallengeTypeDef[] = [];
  for (const article of typeArticles) {
    try {
      const content = await fetcher.getFile(article.path, knowledgeBaseUrl);
      if (!content) continue;

      // Slug from ## Type Identity table
      const slugMatch = content.match(/\|\s*Slug\s*\|\s*([^|]+)\s*\|/);
      const nameMatch = content.match(/\|\s*Name\s*\|\s*([^|]+)\s*\|/);
      if (!slugMatch) continue;
      const slug = slugMatch[1].trim();
      const name = nameMatch ? nameMatch[1].trim() : slug;

      // Opening blockquote (first > line after title)
      const blockquoteMatch = content.match(/^#\s[^\n]+\n+>\s*([^\n]+(?:\n>\s*[^\n]+)*)/m);
      const blockquote = blockquoteMatch
        ? blockquoteMatch[1].replace(/\n>\s*/g, " ").trim()
        : "";

      // Detection patterns — code block under ## Detection Patterns
      const detectionSection = content.match(
        /## Detection Patterns[\s\S]*?```\n([\s\S]*?)\n```/,
      );
      const triggerWords = detectionSection
        ? detectionSection[1]
            .split(",")
            .map((w: string) => w.trim())
            .filter((w: string) => w.length > 0)
        : [];
      // Detection text fed to BM25 = trigger words + blockquote.
      // Stemming handles morphology (coining ~ coin ~ coined ~ coinage)
      // and IDF naturally weights distinctive trigger words above filler.
      const detectionText = [triggerWords.join(" "), blockquote].filter((s) => s.length > 0).join(" ");

      // Challenge Questions table — rows of (Question, Stakes tier)
      const questionsSection = content.match(
        /## Challenge Questions[\s\S]*?\| Question[\s\S]*?\|[-|\s]+\|\n([\s\S]*?)(?=\n\n|\n##|$)/,
      );
      const questions: Array<{ question: string; tier: string }> = [];
      if (questionsSection) {
        for (const row of questionsSection[1].split("\n").filter((r: string) => r.includes("|"))) {
          const cols = parseTableRow(row);
          if (cols.length >= 2) {
            questions.push({ question: cols[0], tier: cols[1].toLowerCase() });
          }
        }
      }

      // Prerequisite Overlays table — rows of (Prerequisite, Check, Gap message).
      // Per P1.3.3 PRD D2: each row is enriched with PrereqMatchVocab (stemmed
      // tokens + structural-test flags) at parse time; see parseCheckColumn.
      const prereqSection = content.match(
        /## Prerequisite Overlays[\s\S]*?\| Prerequisite[\s\S]*?\|[-|\s]+\|\n([\s\S]*?)(?=\n\n|\n##|$)/,
      );
      const prerequisiteOverlays: Array<
        {
          prerequisite: string;
          check: string;
          gapMessage: string;
        } & PrereqMatchVocab
      > = [];
      if (prereqSection) {
        for (const row of prereqSection[1].split("\n").filter((r: string) => r.includes("|"))) {
          const cols = parseTableRow(row);
          if (cols.length >= 3) {
            // Substitute {name} placeholder in gap messages
            const gap = cols[2].replace(/^"|"$/g, "").replace(/\{name\}/g, name);
            prerequisiteOverlays.push({
              prerequisite: cols[0],
              check: cols[1],
              gapMessage: gap,
              ...parseCheckColumn(cols[1]),
            });
          }
        }
      }

      // Suggested Reframings — bullet list
      const reframingsSection = content.match(
        /## Suggested Reframings[\s\S]*?\n((?:-\s+[^\n]+\n?)+)/,
      );
      const reframings: string[] = [];
      if (reframingsSection) {
        for (const line of reframingsSection[1].split("\n")) {
          const m = line.match(/^-\s+(.+)$/);
          if (m) reframings.push(m[1].trim());
        }
      }

      // Fallback flag from frontmatter
      const frontmatter = parseFullFrontmatter(content);
      const fallback = frontmatter?.fallback === true;

      types.push({
        slug,
        name,
        blockquote,
        triggerWords,
        detectionText,
        questions,
        prerequisiteOverlays,
        reframings,
        fallback,
      });
    } catch {
      continue;
    }
  }

  // Sort: fallback types last for deterministic fallback-resolution
  types.sort((a, b) => {
    if (a.fallback && !b.fallback) return 1;
    if (!a.fallback && b.fallback) return -1;
    return a.slug.localeCompare(b.slug);
  });

  cachedChallengeTypes = types;
  cachedChallengeTypesKnowledgeBaseUrl = knowledgeBaseUrl;
  // Source classification per PRD D3: types.length > 0 from canon = "knowledge_base";
  // zero docs parsed = "minimal" (challenge preserves current hollow-response behavior
  // rather than inventing a built-in fallback registry — see PRD D7).
  const source: "knowledge_base" | "minimal" = types.length > 0 ? "knowledge_base" : "minimal";
  cachedChallengeTypesSource = source;
  // Note: the BM25 type-detection index over per-type detection text is
  // NOT cached — it's a microsecond derivation over already-cached parse
  // products, rebuilt inline per request in runChallengeAction. See
  // klappy://canon/principles/cache-fetches-and-parses for the principle
  // and the plumbing-tax argument.
  return { types, source };
}

// Gate minimal-tier vocabulary — P1.3.2 D6. Used when canon is unreachable
// or missing required sections. Vocabulary mirrors the pre-0.20.0 hardcoded
// detectTransition regexes (L306–L324 pre-refactor) and checkPatterns map
// (L2154–L2163 pre-refactor) flattened to comma-separated phrases and
// words. Algorithm is uniform across tiers (BM25 for transitions, set
// intersection for prereqs); only the vocabulary source differs.
const MINIMAL_TRANSITIONS: Array<{
  key: string;
  from: string;
  to: string;
  prereqIds: string[];
  detectionText: string;
}> = [
  {
    key: "planning-to-execution",
    from: "planning",
    to: "execution",
    prereqIds: ["decisions_locked", "dod_defined", "irreversibility_assessed", "constraints_satisfied"],
    detectionText: "ready to build, ready to implement, start building, let's code, start coding, moving to execution, moving to build",
  },
  {
    key: "exploration-to-planning",
    from: "exploration",
    to: "planning",
    prereqIds: ["problem_defined", "constraints_reviewed"],
    detectionText: "ready to plan, start planning, let's plan, time to plan, move to planning, moving to planning, ready, let's go, proceed, move forward, next step",
  },
  {
    key: "execution-to-exploration",
    from: "execution",
    to: "exploration",
    prereqIds: [],
    detectionText: "back to exploration, need to rethink, step back, stepped back, stepping back, reconsider",
  },
  {
    key: "execution-to-completion",
    from: "execution",
    to: "completion",
    prereqIds: ["dod_met", "artifacts_present"],
    detectionText: "ship, shipping, shipped, deploy, release, go live, push to prod",
  },
];

const MINIMAL_PREREQUISITES: Array<{ id: string; check: string; gapMessage: string }> = [
  { id: "problem_defined", check: "problem, goal, objective, need, issue", gapMessage: "Problem statement not defined — the goal or issue being solved is unclear" },
  { id: "constraints_reviewed", check: "constraint, rule, policy, reviewed, checked", gapMessage: "Relevant constraints have not been reviewed — what MUST-rules apply here?" },
  { id: "decisions_locked", check: "decided, locked, chosen, selected, committed", gapMessage: "Key decisions are not locked — which options have been closed?" },
  { id: "dod_defined", check: "definition of done, dod, done when, acceptance criteria", gapMessage: "Definition of done is unclear — what does the finished artifact look like?" },
  { id: "irreversibility_assessed", check: "irreversible, can't undo, one-way, point of no return", gapMessage: "Irreversibility not assessed — which aspects cannot be undone after execution?" },
  { id: "constraints_satisfied", check: "constraints met, constraints satisfied, constraints addressed", gapMessage: "Constraints not confirmed satisfied — are all MUST-rules addressable?" },
  { id: "dod_met", check: "done, complete, finished, all criteria", gapMessage: "DoD not met — the completion claim is missing evidence against the criteria" },
  { id: "artifacts_present", check: "screenshot, test, log, artifact, evidence, proof", gapMessage: "Required artifacts not present — what observable proof exists?" },
];

/** Fetch gate transitions from canon at klappy://odd/gate/transitions.
 *  Parses the `## Transitions` table (columns: Transition Key | From | To | Prerequisites | Detection Terms).
 *  Empty result → source: "minimal" with MINIMAL_TRANSITIONS vocabulary.
 *  BM25 index construction is the caller's responsibility and happens per-request per PRD D9
 *  (microsecond derivation, not worth caching on gate's tiny corpus). */
async function fetchGateTransitions(
  fetcher: KnowledgeBaseFetcher,
  knowledgeBaseUrl?: string,
): Promise<{ transitions: TransitionDef[]; source: "knowledge_base" | "minimal" }> {
  if (cachedGateTransitions && cachedGateTransitionsKnowledgeBaseUrl === knowledgeBaseUrl)
    return { transitions: cachedGateTransitions, source: cachedGateTransitionsSource };

  const parsed: TransitionDef[] = [];
  try {
    const content = await fetcher.getFile("odd/gate/transitions.md", knowledgeBaseUrl);
    if (content) {
      const section = content.match(
        /## Transitions[\s\S]*?\| Transition Key[\s\S]*?\|[-|\s]+\|\n([\s\S]*?)(?=\n\n|\n##|$)/,
      );
      if (section) {
        let rowOrder = 0;
        for (const row of section[1].split("\n").filter((r: string) => r.includes("|"))) {
          const cols = parseTableRow(row);
          if (cols.length >= 5) {
            // Column layout: key | from | to | prereq_ids (comma-separated) | detection terms (comma-separated)
            const key = cols[0].replace(/`/g, "").trim();
            const from = cols[1].trim();
            const to = cols[2].trim();
            const prereqIdsRaw = cols[3].trim();
            const detectionText = cols[4].trim();
            if (key.length === 0) continue;
            const prereqIds = prereqIdsRaw.length > 0
              ? prereqIdsRaw.split(",").map((s: string) => s.trim()).filter((s: string) => s.length > 0)
              : [];
            parsed.push({ key, from, to, prereqIds, detectionText, rowOrder });
            rowOrder++;
          }
        }
      }
    }
  } catch {
    // Graceful degradation: canon unreachable → minimal fallback below
  }

  let transitions: TransitionDef[];
  let source: "knowledge_base" | "minimal";
  if (parsed.length > 0) {
    transitions = parsed;
    source = "knowledge_base";
  } else {
    transitions = MINIMAL_TRANSITIONS.map((t, i) => ({ ...t, rowOrder: i }));
    source = "minimal";
  }

  cachedGateTransitions = transitions;
  cachedGateTransitionsKnowledgeBaseUrl = knowledgeBaseUrl;
  cachedGateTransitionsSource = source;
  return { transitions, source };
}

/** Fetch gate prerequisites from canon at klappy://odd/gate/prerequisites.
 *  Parses the `## Prerequisite Overlays` table (columns: Prerequisite | Check | Gap message).
 *  Precomputes stemmedTokens per prereq at parse time (per PRD D5 + D9 — parse product,
 *  worth caching; prereq matching is stemmed set intersection at runtime, no BM25). */
async function fetchGatePrerequisites(
  fetcher: KnowledgeBaseFetcher,
  knowledgeBaseUrl?: string,
): Promise<{ prerequisites: GatePrerequisite[]; source: "knowledge_base" | "minimal" }> {
  if (cachedGatePrerequisites && cachedGatePrerequisitesKnowledgeBaseUrl === knowledgeBaseUrl)
    return { prerequisites: cachedGatePrerequisites, source: cachedGatePrerequisitesSource };

  const parsed: GatePrerequisite[] = [];
  try {
    const content = await fetcher.getFile("odd/gate/prerequisites.md", knowledgeBaseUrl);
    if (content) {
      const section = content.match(
        /## Prerequisite Overlays[\s\S]*?\| Prerequisite[\s\S]*?\|[-|\s]+\|\n([\s\S]*?)(?=\n\n|\n##|$)/,
      );
      if (section) {
        for (const row of section[1].split("\n").filter((r: string) => r.includes("|"))) {
          const cols = parseTableRow(row);
          if (cols.length >= 3) {
            const id = cols[0].trim();
            const check = cols[1].trim();
            const gapMessage = cols[2].replace(/^"|"$/g, "").trim();
            if (id.length === 0) continue;
            // Precompute stemmed tokens from check vocabulary. tokenize() stems
            // and filters stop words using the default set; for gate's small
            // vocabulary this is appropriate — we want stop-word filtering so
            // multi-word entries like "definition of done" contribute only the
            // content-bearing stems.
            const stemmedTokens = new Set(tokenize(check));
            parsed.push({ id, check, gapMessage, stemmedTokens });
          }
        }
      }
    }
  } catch {
    // Graceful degradation
  }

  let prerequisites: GatePrerequisite[];
  let source: "knowledge_base" | "minimal";
  if (parsed.length > 0) {
    prerequisites = parsed;
    source = "knowledge_base";
  } else {
    prerequisites = MINIMAL_PREREQUISITES.map((p) => ({
      ...p,
      stemmedTokens: new Set(tokenize(p.check)),
    }));
    source = "minimal";
  }

  cachedGatePrerequisites = prerequisites;
  cachedGatePrerequisitesKnowledgeBaseUrl = knowledgeBaseUrl;
  cachedGatePrerequisitesSource = source;
  return { prerequisites, source };
}

async function fetchBasePrerequisites(
  fetcher: KnowledgeBaseFetcher,
  knowledgeBaseUrl?: string,
): Promise<{ prerequisites: BasePrerequisite[]; source: "knowledge_base" | "minimal" }> {
  if (cachedBasePrerequisites && cachedBasePrerequisitesKnowledgeBaseUrl === knowledgeBaseUrl)
    return { prerequisites: cachedBasePrerequisites, source: cachedBasePrerequisitesSource };

  const result: BasePrerequisite[] = [];
  try {
    const content = await fetcher.getFile("odd/challenge/base-prerequisites.md", knowledgeBaseUrl);
    if (content) {
      const prereqSection = content.match(
        /## Prerequisite Overlays[\s\S]*?\| Prerequisite[\s\S]*?\|[-|\s]+\|\n([\s\S]*?)(?=\n\n|\n##|$)/,
      );
      if (prereqSection) {
        for (const row of prereqSection[1].split("\n").filter((r: string) => r.includes("|"))) {
          const cols = parseTableRow(row);
          if (cols.length >= 3) {
            result.push({
              prerequisite: cols[0],
              check: cols[1],
              gapMessage: cols[2].replace(/^"|"$/g, ""),
              ...parseCheckColumn(cols[1]),
            });
          }
        }
      }
    }
  } catch {
    // Graceful degradation: no base prerequisites article → type overlays only
  }

  cachedBasePrerequisites = result;
  cachedBasePrerequisitesKnowledgeBaseUrl = knowledgeBaseUrl;
  // Source classification per PRD D3: result.length > 0 when the canon article
  // parsed at least one overlay row. Empty result = canon unreachable OR article
  // exists but has no rows — in either case the tool falls back to type overlays
  // only, which is the "minimal" tier for this dimension.
  const source: "knowledge_base" | "minimal" = result.length > 0 ? "knowledge_base" : "minimal";
  cachedBasePrerequisitesSource = source;
  return { prerequisites: result, source };
}

async function fetchNormativeVocabulary(
  fetcher: KnowledgeBaseFetcher,
  knowledgeBaseUrl?: string,
): Promise<{ vocabulary: NormativeVocabulary; source: "knowledge_base" | "minimal" }> {
  if (cachedNormativeVocabulary && cachedNormativeVocabularyKnowledgeBaseUrl === knowledgeBaseUrl)
    return { vocabulary: cachedNormativeVocabulary, source: cachedNormativeVocabularySource };

  const caseSensitiveWords: string[] = [];
  const caseInsensitiveWords: string[] = [];
  const directiveTypes = new Map<string, string>();
  const stopWords = new Set<string>();
  // Track whether canon parse produced anything. Left-falling to the hardcoded
  // RFC 2119 fallback below is the "minimal" tier for this dimension.
  let parsedFromCanon = false;

  try {
    const content = await fetcher.getFile("odd/challenge/normative-vocabulary.md", knowledgeBaseUrl);
    if (content) {
      parsedFromCanon = true;
      // ── Surface 1: Normative Vocabulary (signal in canon quotes) ──
      // Two subsections under "## Normative Vocabulary": one keyed by "RFC 2119"
      // or "Directive Language" (case-sensitive), one for architectural-writing
      // load-bearing phrases (case-insensitive). Each is a markdown table with
      // (Word | Directive type).
      const sections = content.split(/###\s+/);
      for (const section of sections) {
        const isCaseSensitive = /RFC 2119|Directive Language/i.test(section.split("\n")[0] || "");
        const tableMatch = section.match(/\|\s*(?:Word|Phrase)\s*\|[\s\S]*?\|[-|\s]+\|\n([\s\S]*?)(?=\n\n|\n##|$)/);
        if (!tableMatch) continue;
        for (const row of tableMatch[1].split("\n").filter((r: string) => r.includes("|"))) {
          const cols = parseTableRow(row);
          if (cols.length >= 2) {
            const phrase = cols[0];
            const dtype = cols[1];
            directiveTypes.set(phrase, dtype);
            if (isCaseSensitive) caseSensitiveWords.push(phrase);
            else caseInsensitiveWords.push(phrase);
          }
        }
      }

      // ── Surface 2: Detection Noise (filler in user input) ──
      // A code block of comma-and-newline separated words under "## Detection
      // Noise". The set is passed to the BM25 indexer as the custom stop-word
      // filter. Modal verbs and negation are deliberately absent — they are
      // signal for strong-claim, proposal, and assumption type detection.
      // If the section is missing, stopWords stays empty and BM25 falls back
      // to IDF-only filtering — an explicit governance choice in the article.
      const noiseMatch = content.match(/## Detection Noise[\s\S]*?```\n([\s\S]*?)\n```/);
      if (noiseMatch) {
        for (const word of noiseMatch[1].split(/[,\n]/)) {
          const w = word.trim().toLowerCase();
          if (w.length > 0) stopWords.add(w);
        }
      }
    }
  } catch {
    // Graceful degradation below
  }

  // Fallback: minimal built-in RFC 2119 if article missing
  if (caseSensitiveWords.length === 0 && caseInsensitiveWords.length === 0) {
    for (const w of ["MUST", "MUST NOT", "SHOULD", "SHOULD NOT"]) {
      caseSensitiveWords.push(w);
      directiveTypes.set(w, w.includes("NOT") ? "prohibition" : "requirement");
    }
  }

  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const caseSensitiveRegex =
    caseSensitiveWords.length > 0
      ? new RegExp(
          "\\b(" +
            [...caseSensitiveWords].sort((a, b) => b.length - a.length).map(escape).join("|") +
            ")\\b",
          "g",
        )
      : null;
  const caseInsensitiveRegex =
    caseInsensitiveWords.length > 0
      ? new RegExp(
          "(" +
            [...caseInsensitiveWords].sort((a, b) => b.length - a.length).map(escape).join("|") +
            ")",
          "gi",
        )
      : null;

  const vocab: NormativeVocabulary = {
    caseSensitiveRegex,
    caseInsensitiveRegex,
    directiveTypes,
    stopWords,
  };
  cachedNormativeVocabulary = vocab;
  cachedNormativeVocabularyKnowledgeBaseUrl = knowledgeBaseUrl;
  // Source classification per PRD D3: parsedFromCanon is true iff the canon article
  // returned content; false means the hardcoded RFC 2119 fallback took over. The
  // vocab article having content but parsing zero rows is still "knowledge_base"
  // (canon authoritatively said the lists are empty), not "minimal".
  const source: "knowledge_base" | "minimal" = parsedFromCanon ? "knowledge_base" : "minimal";
  cachedNormativeVocabularySource = source;
  return { vocabulary: vocab, source };
}

async function fetchStakesCalibration(
  fetcher: KnowledgeBaseFetcher,
  knowledgeBaseUrl?: string,
): Promise<{ calibration: StakesCalibration; source: "knowledge_base" | "minimal" }> {
  if (cachedStakesCalibration && cachedStakesCalibrationKnowledgeBaseUrl === knowledgeBaseUrl)
    return { calibration: cachedStakesCalibration, source: cachedStakesCalibrationSource };

  const byMode = new Map<string, StakesModeConfig>();
  try {
    const content = await fetcher.getFile("odd/challenge/stakes-calibration.md", knowledgeBaseUrl);
    if (content) {
      // Parse the Stakes Calibration table:
      // | Mode | Question tiers surfaced | Prerequisite strictness | Reframings surfaced |
      const tableMatch = content.match(
        /## Stakes Calibration[\s\S]*?\| Mode[\s\S]*?\|[-|\s]+\|\n([\s\S]*?)(?=\n\n|\n##|$)/,
      );
      if (tableMatch) {
        for (const row of tableMatch[1].split("\n").filter((r: string) => r.includes("|"))) {
          const cols = parseTableRow(row);
          if (cols.length >= 4) {
            const mode = cols[0].toLowerCase();
            const tiersRaw = cols[1].toLowerCase().trim();
            // The cell may be "none" or "none (suppress all challenge)" — both mean
            // empty tier list and trigger the voice-dump suppression invariant.
            // Without this leading-"none" check the suppression invariant ships broken.
            const isNone = tiersRaw === "none" || tiersRaw.startsWith("none ") || tiersRaw.startsWith("none(");
            const questionTiers: string[] = isNone
              ? []
              : tiersRaw.split(",").map((t: string) => t.trim()).filter((t: string) => t.length > 0);
            byMode.set(mode, {
              questionTiers,
              prerequisiteStrictness: cols[2],
              reframingSurfacing: cols[3],
            });
          }
        }
      }
    }
  } catch {
    // Graceful degradation below
  }

  cachedStakesCalibration = { byMode };
  cachedStakesCalibrationKnowledgeBaseUrl = knowledgeBaseUrl;
  // Source classification per PRD D3: byMode populated from canon = "knowledge_base";
  // zero modes parsed = "minimal" (runChallengeAction falls to "uniformly loud"
  // undefined-modeConfig branch at the call site, already handled there).
  const source: "knowledge_base" | "minimal" = byMode.size > 0 ? "knowledge_base" : "minimal";
  cachedStakesCalibrationSource = source;
  return { calibration: cachedStakesCalibration, source };
}

function isStructuredInput(input: string): boolean {
  const lines = input.split("\n").filter((l) => l.trim().length > 0);
  return lines.length > 0 && lines.every((l) => /^[A-Z]\t/.test(l));
}

// ──────────────────────────────────────────────────────────────────────────────
// DOLCHEO prefix-tag batch parser
//
// Recognizes paragraph-split input where each paragraph optionally begins with
// a DOLCHEO letter tag:
//
//   [D]        Decision
//   [O]        Observation (closed)
//   [L]        Learning
//   [C]        Constraint
//   [H]        Handoff
//   [E]        Encode
//   [O-open]           Open item (forward-pointing facet of O)
//   [O-open P1]        Open item with priority band
//   [O-open P2.1]      Open item with sub-band
//
// Per canon/definitions/dolcheo-vocabulary — both Os remain letter O; the
// -open suffix is a facet, not a new letter. Paragraphs without a recognized
// prefix are left for the unstructured trigger-word fallback.
// ──────────────────────────────────────────────────────────────────────────────

// Matches [LETTER] for any DOLCHEO letter (D/O/L/C/H/E), or [O-open] /
// [O-open P1] / [O-open P2.1] at paragraph start. The -open facet and the
// priority band are exclusive to the O (Observation) letter per
// canon/definitions/dolcheo-vocabulary — they are not accepted on other
// letters. Restricting the letter set to the six DOLCHEO letters also
// prevents misrouting unstructured input that happens to begin a paragraph
// with an unrelated bracketed letter (e.g. enumerated points like "[A] ...").
//
// Capture groups:
//   1 — non-O DOLCHEO letter ([DLCHE]) when no facet/band applies
//   2 — "O" letter when the O branch matches (with optional facet/band)
//   3 — "open" facet (only on O)
//   4 — priority band "P1" / "P2.1" (only on O)
const PREFIX_TAG_REGEX = /^\[(?:([DLCHE])|(O)(?:-(open)(?:\s+(P\d+(?:\.\d+)?))?)?)\]\s*/;

function isPrefixedBatchInput(input: string): boolean {
  const paragraphs = input.split(/\n\n+/).map((p) => p.trim()).filter((p) => p.length > 0);
  if (paragraphs.length === 0) return false;
  // At least one paragraph must carry a prefix tag. Mixed input (some tagged,
  // some not) routes through this path — untagged paragraphs drop through to
  // the existing trigger-word classification inside the parser.
  return paragraphs.some((p) => PREFIX_TAG_REGEX.test(p));
}

// Phrase-subset match — a phrase matches when ALL of its stems appear in the
// input stem set. Short-circuits on the first phrase that matches. The D5
// matcher shape for encode trigger-word classification, mirroring the shape
// used by evaluatePrerequisiteCheck in the P1.3.3 challenge evaluator:
// single-stem phrases degenerate to set membership (identical to the old
// single-token behavior), while multi-stem phrases like
// `committed to` → ["committ","to"] require both stems to co-occur, so
// ubiquitous function words cannot match on their own.
function matchesStemmedPhrases(phrases: string[][], input: Set<string>): boolean {
  for (const phrase of phrases) {
    let allPresent = true;
    for (const stem of phrase) {
      if (!input.has(stem)) { allPresent = false; break; }
    }
    if (allPresent) return true;
  }
  return false;
}

function parsePrefixedBatchInput(input: string, types: EncodingTypeDef[]): ParsedArtifact[] {
  const typeMap = new Map(types.map((t) => [t.letter, t.name]));
  const paragraphs = input.split(/\n\n+/).map((p) => p.trim()).filter((p) => p.length > 0);
  const artifacts: ParsedArtifact[] = [];

  for (const para of paragraphs) {
    const match = para.match(PREFIX_TAG_REGEX);
    if (match) {
      // match[1]: non-O letter ([DLCHE]); match[2]: "O" when O branch matched.
      // Facet and band are only captured on the O branch — enforced by regex.
      const letter = match[1] || match[2];
      const facet = match[3]; // "open" | undefined (O only)
      const band = match[4];  // "P1" | "P2.1" | undefined (O only)
      const body = para.slice(match[0].length).trim();
      const first = body.split(/[.!?\n]/)[0]?.trim() || body.slice(0, 60);
      const title = first.split(/\s+/).length <= 12
        ? first
        : first.split(/\s+/).slice(0, 8).join(" ") + "...";
      const baseName = typeMap.get(letter) || letter;
      const typeName = facet === "open" ? `${baseName} (Open)` : baseName;
      const artifact: ParsedArtifact = {
        type: letter,
        typeName,
        fields: [letter, title, body],
        title,
        body,
      };
      if (facet) artifact.facet = facet;
      if (band) artifact.priority_band = band;
      artifacts.push(artifact);
    } else {
      // Untagged paragraph in a batch that contains tags: classify via trigger
      // words like parseUnstructuredInput, but emit one artifact per paragraph
      // (not one-per-match) to preserve the author's paragraph boundaries.
      // Stemmed set intersection mirrors parseUnstructuredInput — stop-words
      // disabled on tokenize() both sides per P1.3.3 C-04 (canon vocab
      // includes stop-word phrases like `going with` / `must not`).
      let matched: EncodingTypeDef | null = null;
      const inputStems = new Set(tokenize(para, new Set()));
      for (const t of types) {
        // Break on first match: this path picks one type per paragraph by
        // design (paragraph boundaries are the author's). Unlike
        // parseUnstructuredInput which emits one artifact per matching type.
        if (matchesStemmedPhrases(t.stemmedPhrases, inputStems)) { matched = t; break; }
      }
      const pick = matched ?? types[0] ?? { letter: "D", name: "Decision" };
      const first = para.split(/[.!?\n]/)[0]?.trim() || para.slice(0, 60);
      const title = first.split(/\s+/).length <= 12
        ? first
        : first.split(/\s+/).slice(0, 8).join(" ") + "...";
      artifacts.push({
        type: pick.letter,
        typeName: pick.name,
        fields: [pick.letter, title, para],
        title,
        body: para,
      });
    }
  }

  return artifacts;
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
    // Hoist tokenize(para) out of the per-type loop — para is constant across
    // the loop, stemmedTokens differ per type. Mirrors the P1.3.3 challenge
    // prereq evaluator shape. Stop-words disabled (empty Set) on both parse-
    // time and runtime tokenize() calls so canon vocab like `going with`,
    // `must not`, `turns out`, `found that` survives on both sides. Per
    // canon/constraints/release-validation-gate and P1.3.3 Bug #1 precedent.
    const inputStems = new Set(tokenize(para, new Set()));
    for (const t of types) {
      // DESIGN: no break — a paragraph can match multiple types intentionally.
      // "We must never deploy without tests" is both Decision and Constraint.
      // Multi-typing at the server level mirrors what the model would do with
      // separate TSV rows. Do not add a break here.
      if (matchesStemmedPhrases(t.stemmedPhrases, inputStems)) {
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
  fetcher: KnowledgeBaseFetcher,
  knowledgeBaseUrl?: string,
  state?: OddkitState,
  includeMetadata?: boolean,
): Promise<ActionResult> {
  const startMs = Date.now();
  const index = await fetcher.getIndex(knowledgeBaseUrl);
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
        knowledge_base_url: knowledgeBaseUrl,
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
    const content = await fetcher.getFile(entry.path, knowledgeBaseUrl);
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
      const fileContent = contentCache.get(h.path) ?? (await fetcher.getFile(h.path, knowledgeBaseUrl));
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
      knowledge_base_url: knowledgeBaseUrl,
      search_index_size: bm25.N,
      duration_ms: Date.now() - startMs,
      generated_at: new Date().toISOString(),
    },
  };
}

async function runGet(
  input: string,
  fetcher: KnowledgeBaseFetcher,
  knowledgeBaseUrl?: string,
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
    const index = await fetcher.getIndex(knowledgeBaseUrl);
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

  const content = await fetcher.getFile(path, knowledgeBaseUrl);
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
      baseline_url: env.DEFAULT_KNOWLEDGE_BASE_URL,
    },
    assistant_text: `oddkit v${env.ODDKIT_VERSION || pkg.version}`,
    debug: { generated_at: new Date().toISOString() },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// runResolve — protocol-level URI resolution with transparent supersession.
//
// Per klappy://docs/oddkit/specs/oddkit-resolve (DRAFT v4 — KISS) and
// klappy://canon/principles/identity-resolved-by-protocol: consumers pass
// in a klappy:// URI; the protocol returns the current canonical answer,
// walking superseded_by chains to terminus. Backward-compatible (net-new).
// ──────────────────────────────────────────────────────────────────────────────

async function runResolve(
  input: string,
  fetcher: KnowledgeBaseFetcher,
  knowledgeBaseUrl?: string,
  state?: OddkitState,
): Promise<ActionResult> {
  const startMs = Date.now();
  const updatedState = state ? initState(state) : undefined;

  if (!input || typeof input !== "string" || !input.startsWith("klappy://")) {
    return {
      action: "resolve",
      result: {
        status: "INVALID_INPUT",
        error: "input must be a klappy:// URI",
      },
      state: updatedState,
      assistant_text: `Invalid input: \`${input}\`. Expected a klappy:// URI.`,
      debug: { duration_ms: Date.now() - startMs, generated_at: new Date().toISOString() },
    };
  }

  const index = await fetcher.getIndex(knowledgeBaseUrl);

  // Build a URI → entry lookup once. Index entries already carry full frontmatter
  // per klappy://docs/oddkit/IMPL-catalog-recent.
  const byUri = new Map<string, IndexEntry>();
  for (const entry of index.entries) {
    if (entry.uri) byUri.set(entry.uri, entry);
  }

  const startEntry = byUri.get(input);
  if (!startEntry) {
    return {
      action: "resolve",
      result: {
        status: "NOT_FOUND",
        input_uri: input,
      },
      state: updatedState,
      assistant_text: `URI not found in index: \`${input}\`.`,
      debug: { duration_ms: Date.now() - startMs, generated_at: new Date().toISOString() },
    };
  }

  // Walk superseded_by chain to terminus.
  // Cap traversal depth as a safety net against malformed canon (cycles or absurd chains).
  // Cycles produce CIRCULAR_SUPERSESSION; depth-cap produces the same with a different reason.
  const MAX_DEPTH = 16;
  const chain: Array<{ uri: string; superseded_at?: string }> = [];
  const visited = new Set<string>([startEntry.uri]);

  let current: IndexEntry = startEntry;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const fm = current.frontmatter || {};
    const next = fm.superseded_by;
    if (typeof next !== "string" || next.length === 0) break;

    const supersededAt = typeof fm.superseded_at === "string" ? fm.superseded_at : undefined;
    chain.push({ uri: current.uri, ...(supersededAt ? { superseded_at: supersededAt } : {}) });

    if (visited.has(next)) {
      return {
        action: "resolve",
        result: {
          status: "CIRCULAR_SUPERSESSION",
          input_uri: input,
          supersession_chain: [...chain, { uri: next }],
          message: "superseded_by chain cycles",
        },
        state: updatedState,
        assistant_text: `Circular supersession detected starting from \`${input}\`. This is a canon data error.`,
        debug: { duration_ms: Date.now() - startMs, generated_at: new Date().toISOString() },
      };
    }

    const nextEntry = byUri.get(next);
    if (!nextEntry) {
      // Chain points at a URI that doesn't exist. Treat as resolution to the last
      // known entry in the chain (stop walking) plus a warning in the result.
      return {
        action: "resolve",
        result: {
          status: "FOUND",
          input_uri: input,
          resolved: {
            uri: current.uri,
            path: current.path,
            title: current.title,
            url: deriveUrl(current.uri),
            content_hash: current.content_hash,
          },
          supersession_chain: chain.slice(0, -1),
          warning: `superseded_by points at \`${next}\` which is not in the index; chain truncated`,
        },
        state: state ? addCanonRefs(initState(state), [current.path]) : undefined,
        assistant_text: `Resolved \`${input}\` to \`${current.uri}\` (chain truncated at unknown successor \`${next}\`).`,
        debug: { duration_ms: Date.now() - startMs, generated_at: new Date().toISOString() },
      };
    }

    visited.add(next);
    current = nextEntry;
  }

  // If we exited the loop on the depth cap with current still pointing at a doc that
  // declares a further successor, treat that as circular for safety.
  const finalFm = current.frontmatter || {};
  if (typeof finalFm.superseded_by === "string" && finalFm.superseded_by.length > 0) {
    return {
      action: "resolve",
      result: {
        status: "CIRCULAR_SUPERSESSION",
        input_uri: input,
        supersession_chain: chain,
        message: `chain exceeded MAX_DEPTH=${MAX_DEPTH}`,
      },
      state: updatedState,
      assistant_text: `Supersession chain too deep starting from \`${input}\` (>${MAX_DEPTH}). Treating as canon data error.`,
      debug: { duration_ms: Date.now() - startMs, generated_at: new Date().toISOString() },
    };
  }

  return {
    action: "resolve",
    result: {
      status: "FOUND",
      input_uri: input,
      resolved: {
        uri: current.uri,
        path: current.path,
        title: current.title,
        url: deriveUrl(current.uri),
        content_hash: current.content_hash,
      },
      supersession_chain: chain,
    },
    state: state ? addCanonRefs(initState(state), [current.path]) : undefined,
    assistant_text:
      chain.length === 0
        ? `Resolved \`${input}\` (no supersession).`
        : `Resolved \`${input}\` → \`${current.uri}\` via ${chain.length} supersession step${chain.length === 1 ? "" : "s"}.`,
    debug: { duration_ms: Date.now() - startMs, generated_at: new Date().toISOString() },
  };
}

/**
 * Derive a public-friendly URL from a klappy:// URI.
 * v1 mapping: klappy://writings/foo → /writings/foo, klappy://canon/x → /canon/x, etc.
 * Pure derivation — no I/O. Consumers that need a different URL shape can override
 * by reading the resolved.uri/path themselves.
 */
function deriveUrl(uri: string): string {
  if (!uri.startsWith("klappy://")) return uri;
  return "/" + uri.slice("klappy://".length);
}

async function runCleanupStorage(
  fetcher: KnowledgeBaseFetcher,
  knowledgeBaseUrl?: string,
): Promise<ActionResult> {
  await fetcher.invalidateCache(knowledgeBaseUrl);
  // Also clear the in-memory BM25 index
  cachedBM25Index = null;
  cachedBM25Entries = null;
  // cachedEncodingTypes removed in 0.23.0 per cache-fetches-and-parses —
  // encode's parse product is no longer cached in-process. The fetch tier
  // (Cache API, R2) already handles canon file caching; the derivation is
  // sub-millisecond. No reset needed here.
  // E0008 — governance-driven challenge caches (mirror PR #96 fix)
  cachedChallengeTypes = null;
  cachedChallengeTypesKnowledgeBaseUrl = undefined;
  cachedChallengeTypesSource = "minimal";
  cachedBasePrerequisites = null;
  cachedBasePrerequisitesKnowledgeBaseUrl = undefined;
  cachedBasePrerequisitesSource = "minimal";
  cachedNormativeVocabulary = null;
  cachedNormativeVocabularyKnowledgeBaseUrl = undefined;
  cachedNormativeVocabularySource = "minimal";
  cachedStakesCalibration = null;
  cachedStakesCalibrationKnowledgeBaseUrl = undefined;
  cachedStakesCalibrationSource = "minimal";
  // E0008.3 — gate governance caches (P1.3.2, 0.20.0)
  cachedGateTransitions = null;
  cachedGateTransitionsKnowledgeBaseUrl = undefined;
  cachedGateTransitionsSource = "minimal";
  cachedGatePrerequisites = null;
  cachedGatePrerequisitesKnowledgeBaseUrl = undefined;
  cachedGatePrerequisitesSource = "minimal";

  return {
    action: "cleanup_storage",
    result: { success: true, knowledge_base_url: knowledgeBaseUrl },
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
  fetcher: KnowledgeBaseFetcher,
  knowledgeBaseUrl?: string,
  state?: OddkitState,
): Promise<ActionResult> {
  // Delegate to search (BM25) for better results
  return runSearch(message, fetcher, knowledgeBaseUrl, state);
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
  fetcher: KnowledgeBaseFetcher,
  knowledgeBaseUrl?: string,
  state?: OddkitState,
  options?: { sort_by?: string; limit?: number; offset?: number; filter_epoch?: string },
): Promise<ActionResult> {
  const startMs = Date.now();
  const index = await fetcher.getIndex(knowledgeBaseUrl);
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
    knowledgeBaseUrl ? `Canon override: ${knowledgeBaseUrl}` : "",
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
      knowledge_base_url: knowledgeBaseUrl,
      baseline_url: index.baseline_url,
      generated_at: new Date().toISOString(),   // response time — consistent with all other handlers
      index_built_at: index.generated_at,       // preserve cache-freshness diagnostic under accurate name
      duration_ms: Date.now() - startMs,
    },
  };
}

async function runPreflight(
  message: string,
  fetcher: KnowledgeBaseFetcher,
  knowledgeBaseUrl?: string,
  state?: OddkitState,
): Promise<ActionResult> {
  const startMs = Date.now();
  const index = await fetcher.getIndex(knowledgeBaseUrl);
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
      knowledge_base_url: knowledgeBaseUrl,
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
  fetcher: KnowledgeBaseFetcher,
  knowledgeBaseUrl?: string,
  state?: OddkitState,
): Promise<ActionResult> {
  const startMs = Date.now();
  const { mode, confidence } = detectMode(input);
  const index = await fetcher.getIndex(knowledgeBaseUrl);
  const results = scoreEntries(index.entries, input).slice(0, 3);

  // Read creed from baseline (always included in orient response)
  let creed: string[] | null = null;
  try {
    const orientContent = await fetcher.getFile("canon/values/orientation.md", knowledgeBaseUrl);
    if (orientContent) {
      creed = extractCreedFromContent(orientContent);
    }
  } catch {
    // Creed is best-effort; orient works without it
  }

  const canonRefs: Array<{ path: string; quote: string }> = [];
  for (const entry of results) {
    const content = await fetcher.getFile(entry.path, knowledgeBaseUrl);
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

// Governance-driven tension detection helper.
//
// `.match()` with a combined alternation returns the *leftmost* hit, so
// "You MUST do X and MUST NOT do Y" would resolve to "MUST" (requirement)
// even though a prohibition is present later in the excerpt. Collect all
// matches via `matchAll` and prefer a prohibition over any other directive
// type, falling back to the leftmost match otherwise. This preserves the
// prior two-test priority (MUST NOT before MUST) without coupling to a
// hard-coded vocabulary.
function pickStrongestDirective(
  matches: IterableIterator<RegExpMatchArray>,
  lookup: (phrase: string) => string | undefined,
): { phrase: string; dtype: string } | null {
  let first: { phrase: string; dtype: string } | null = null;
  let prohibition: { phrase: string; dtype: string } | null = null;
  for (const m of matches) {
    const phrase = m[1];
    const dtype = lookup(phrase) || "directive";
    if (!first) first = { phrase, dtype };
    if (!prohibition && dtype === "prohibition") prohibition = { phrase, dtype };
  }
  return prohibition || first;
}

async function runChallengeAction(
  input: string,
  modeHint: string | undefined,
  fetcher: KnowledgeBaseFetcher,
  knowledgeBaseUrl?: string,
  state?: OddkitState,
): Promise<ActionResult> {
  const startMs = Date.now();
  const mode = (modeHint || "planning").toLowerCase();

  // Load governance in parallel. Each helper returns a { <domainNoun>, source }
  // tuple per PRD D3; aggregate the four source flags into a single envelope
  // signal per PRD D1 (strict: any helper minimal → aggregate minimal).
  const [
    { types, source: typesSource },
    { prerequisites: basePrereqs, source: basePrereqsSource },
    { vocabulary: vocab, source: vocabSource },
    { calibration, source: calibrationSource },
  ] = await Promise.all([
    discoverChallengeTypes(fetcher, knowledgeBaseUrl),
    fetchBasePrerequisites(fetcher, knowledgeBaseUrl),
    fetchNormativeVocabulary(fetcher, knowledgeBaseUrl),
    fetchStakesCalibration(fetcher, knowledgeBaseUrl),
  ]);

  // Aggregate: strict union per canon/constraints/core-governance-baseline.
  // Two-tier today (workers/baseline/ not shipped — see PRD §3.2); when the
  // bundled tier ships later, this union expands additively to include
  // "bundled" without breaking consumers.
  const governanceSource: "knowledge_base" | "minimal" =
    [typesSource, basePrereqsSource, vocabSource, calibrationSource].some((s) => s === "minimal")
      ? "minimal"
      : "knowledge_base";

  // Four peer governance URIs per PRD D4 — shape diverges from encode's
  // singular governance_uri by design. Challenge's governance surfaces are
  // peers (not a hierarchy), so a single anchor would misrepresent where
  // base-prerequisites and normative-vocabulary live. Alphabetical by
  // path-tail for stability; consumers that want a singular anchor can read
  // governance_uris[0].
  const governanceUris = [
    "klappy://odd/challenge/base-prerequisites",
    "klappy://odd/challenge-types",
    "klappy://odd/challenge/normative-vocabulary",
    "klappy://odd/challenge/stakes-calibration",
  ];

  const modeConfig = calibration.byMode.get(mode);

  // Detect matching types via BM25 over per-type detection text.
  // Stemming makes "coining" match "coin", "rolled" match "rollback", etc.
  // score > 0 = match (BM25 returns 0 when no stemmed query terms hit).
  // Multi-match preserved: a single input may score against several types.
  // Detection runs BEFORE the voice-dump suppression check so the SUPPRESSED
  // response can still expose `governance` — the model sees what would have
  // fired without surfacing the pressure-test questions.
  // Build BM25 type-detection index inline per request (not cached) —
  // per klappy://canon/principles/cache-fetches-and-parses, a BM25 index
  // over challenge's 6–9-type corpus is a microsecond derivation and the
  // plumbing tax is not worth the rebuild cost. Parse products (types,
  // vocab) are cached upstream; the index is just a reshape.
  // Stop words come from `## Detection Noise` in normative-vocabulary.md
  // (governance), not a hardcoded constant in this file.
  const bm25Docs = types.map((t) => ({ id: t.slug, text: t.detectionText }));
  const typeIndex = buildBM25Index(bm25Docs, vocab.stopWords);
  const matchedTypes: ChallengeTypeDef[] = [];
  const hits = searchBM25(typeIndex, input, types.length);
  const typeBySlug = new Map(types.map((t) => [t.slug, t]));
  for (const hit of hits) {
    const t = typeBySlug.get(hit.id);
    if (t) matchedTypes.push(t);
  }

  // Fallback resolution when no type scored above zero
  if (matchedTypes.length === 0) {
    const fallback = types.find((t) => t.fallback) || types[0];
    if (fallback) matchedTypes.push(fallback);
  }

  // Voice-dump invariant: suppress all challenge output regardless of matched types.
  // Encoded at klappy://odd/challenge/stakes-calibration. Some modes exist for getting
  // thoughts out of the head; pressure-testing at that stage damages the mode.
  // The `governance` field is still surfaced so the model sees what types matched.
  if (modeConfig && modeConfig.questionTiers.length === 0) {
    return {
      action: "challenge",
      result: {
        status: "SUPPRESSED",
        mode,
        claim_type: matchedTypes[0]?.slug,
        matched_types: matchedTypes.map((t) => t.slug),
        governance: matchedTypes.map((t) => ({
          slug: t.slug,
          name: t.name,
          description: t.blockquote,
        })),
        governance_source: governanceSource,
        governance_uris: governanceUris,
        tensions: [],
        missing_prerequisites: [],
        challenges: [],
        suggested_reframings: [],
        canon_constraints: [],
        suppression_reason:
          `Mode '${mode}' suppresses challenge output. Challenge is not applied during raw thought capture.`,
      },
      state: state ? initState(state) : undefined,
      assistant_text: `Challenge suppressed for mode '${mode}'. Raw thought capture protected.`,
      debug: {
        duration_ms: Date.now() - startMs,
        generated_at: new Date().toISOString(),
        knowledge_base_url: knowledgeBaseUrl,
      },
    };
  }

  // Aggregate questions across matched types, deduped by question string
  const questionMap = new Map<string, { question: string; tier: string }>();
  for (const t of matchedTypes) {
    for (const q of t.questions) {
      if (!questionMap.has(q.question)) questionMap.set(q.question, q);
    }
  }

  // Aggregate prerequisite overlays: base + all matched type overlays, deduped by prerequisite name
  const prereqMap = new Map<string, BasePrerequisite>();
  for (const p of basePrereqs) {
    prereqMap.set(p.prerequisite, p);
  }
  for (const t of matchedTypes) {
    for (const p of t.prerequisiteOverlays) {
      if (!prereqMap.has(p.prerequisite)) prereqMap.set(p.prerequisite, p);
    }
  }

  // Aggregate reframings across matched types, deduped by string equality
  const reframingSet = new Set<string>();
  const reframingsByType = new Map<string, string[]>();
  for (const t of matchedTypes) {
    const typeReframings: string[] = [];
    for (const r of t.reframings) {
      if (!reframingSet.has(r)) {
        reframingSet.add(r);
        typeReframings.push(r);
      }
    }
    reframingsByType.set(t.slug, typeReframings);
  }

  // Apply stakes calibration: filter questions by tier, evaluate prerequisites by strictness,
  // surface reframings by the surfacing rule. When modeConfig is absent (no calibration
  // article or mode not in table), surface everything — "uniformly loud" fallback.
  // Note: the questionTiers.length === 0 case is impossible here because the
  // SUPPRESSED early-return above already handled it. We branch only on
  // modeConfig presence and tier-membership.
  const surfacedQuestions: string[] = [];
  for (const q of questionMap.values()) {
    if (!modeConfig || modeConfig.questionTiers.includes(q.tier)) {
      surfacedQuestions.push(q.question);
    }
  }

  const strictness = modeConfig?.prerequisiteStrictness?.toLowerCase() || "required";
  // Hoist tokenize(input) out of the per-prereq loop — input is constant across
  // the loop, stemmedTokens differ per prereq. Per PRD D3 (P1.3.3): stemmed
  // set intersection at runtime, structural tests preserved, no regex compile
  // per check. This is the fit-to-problem matcher per D5.
  // Stop-word filtering is disabled (empty Set) so this matches the parse-time
  // tokenize() call in parseCheckColumn. Canon vocab includes stop-words like
  // `from` (source-named) — both sides must share shape or strictly-additive
  // breaks. Per Bugbot finding on PR #120 / #121.
  const inputStems = new Set(tokenize(input, new Set()));
  const missing: string[] = [];
  for (const p of prereqMap.values()) {
    const passed = evaluatePrerequisiteCheck(inputStems, input, p);
    if (!passed) {
      // source-named check is escalated to blocking when strictness says so
      if (strictness.includes("optional") && !p.prerequisite.includes("source-named")) {
        continue;
      }
      missing.push(p.gapMessage);
    }
  }

  const surfacing = modeConfig?.reframingSurfacing?.toLowerCase() || "all";
  const allReframings: string[] = [];
  for (const typeReframings of reframingsByType.values()) {
    allReframings.push(...typeReframings);
  }
  let surfacedReframings: string[] = [];
  // Same defensive shape as the tiersRaw "none" check in fetchStakesCalibration.
  // The cell may be "none" or "none (parenthetical reason)" — both mean suppress
  // all reframings. Strict equality would let the parenthetical fall through to
  // the "all" branch and silently surface every reframing for a mode that opted
  // out of them.
  const surfaceNone =
    surfacing === "none" || surfacing.startsWith("none ") || surfacing.startsWith("none(");
  if (surfaceNone) {
    surfacedReframings = [];
  } else if (
    surfacing.includes("first 1") ||
    surfacing.includes("first-1") ||
    surfacing.includes("first one")
  ) {
    // Surface at most one reframing total — across all matched types, not one per type.
    // The governance phrase "first 1" means a single reframing in the response;
    // multi-match should not multiply the surfacing.
    surfacedReframings = allReframings.slice(0, 1);
  } else {
    // "all" or "all, plus block-until-addressed"
    surfacedReframings = allReframings;
  }
  const blockUntilAddressed = surfacing.includes("block-until-addressed");

  // Retrieve canon quotes and detect tensions via governance-driven vocabulary
  const index = await fetcher.getIndex(knowledgeBaseUrl);
  const results = scoreEntries(index.entries, `constraints challenges risks ${input}`).slice(0, 4);

  const canonConstraints: Array<{ citation: string; quote: string }> = [];
  const tensions: Array<{ type: string; message: string; citation?: string; quote?: string }> = [];
  for (const entry of results) {
    const content = await fetcher.getFile(entry.path, knowledgeBaseUrl);
    if (content) {
      const stripped = content.replace(/^---[\s\S]*?---\n/, "");
      const lines = stripped.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
      const excerpt = lines.slice(0, 2).join(" ").slice(0, 150);
      const citation = `${entry.path}#${entry.title}`;
      canonConstraints.push({ citation, quote: excerpt });

      if (vocab.caseSensitiveRegex) {
        const hit = pickStrongestDirective(
          excerpt.matchAll(vocab.caseSensitiveRegex),
          (p) => vocab.directiveTypes.get(p),
        );
        if (hit) {
          tensions.push({
            type: hit.dtype,
            message: `Canon ${hit.dtype} (${hit.phrase}) found in ${entry.path}`,
            citation,
            quote: excerpt,
          });
          continue;
        }
      }
      if (vocab.caseInsensitiveRegex) {
        const hit = pickStrongestDirective(
          excerpt.matchAll(vocab.caseInsensitiveRegex),
          (p) => vocab.directiveTypes.get(p) || vocab.directiveTypes.get(p.toLowerCase()) || "load-bearing-claim",
        );
        if (hit) {
          tensions.push({
            type: hit.dtype,
            message: `Canon ${hit.dtype} (${hit.phrase}) found in ${entry.path}`,
            citation,
            quote: excerpt,
          });
        }
      }
    }
  }

  // Update state
  const updatedState = state ? initState(state) : undefined;
  if (updatedState && missing.length > 0) {
    updatedState.unresolved = [...updatedState.unresolved, ...missing];
  }

  // Assistant text — preserves prior format, extends with matched types and mode
  const matchedSlugs = matchedTypes.map((t) => t.slug);
  const lines = [`Challenge (${matchedSlugs.join(", ") || "no-match"}) [mode: ${mode}]:`, ""];
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
  if (surfacedQuestions.length > 0) {
    lines.push("Questions to address:");
    for (const c of surfacedQuestions) lines.push(`  - ${c}`);
    lines.push("");
  }
  if (surfacedReframings.length > 0) {
    lines.push("Suggested reframings:");
    for (const r of surfacedReframings) lines.push(`  - ${r}`);
    lines.push("");
  }
  if (blockUntilAddressed && (missing.length > 0 || tensions.length > 0)) {
    lines.push(
      "⚠ Block-until-addressed: in this mode, the claim should not proceed until the gaps above are resolved or explicitly declined.",
    );
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
      mode,
      claim_type: matchedSlugs[0],
      matched_types: matchedSlugs,
      governance: matchedTypes.map((t) => ({
        slug: t.slug,
        name: t.name,
        description: t.blockquote,
      })),
      governance_source: governanceSource,
      governance_uris: governanceUris,
      tensions,
      missing_prerequisites: missing,
      challenges: surfacedQuestions,
      suggested_reframings: surfacedReframings,
      block_until_addressed: blockUntilAddressed,
      canon_constraints: canonConstraints,
    },
    state: updatedState,
    assistant_text: lines.join("\n").trim(),
    debug: {
      duration_ms: Date.now() - startMs,
      generated_at: new Date().toISOString(),
      knowledge_base_url: knowledgeBaseUrl,
    },
  };
}

// Parse-time helper: extract quoted keywords from a `check` description and
// detect the four structural-test hints. Called at canon-fetch time from
// both discoverChallengeTypes (per-type prereqs) and fetchBasePrerequisites
// (universal prereqs). Produces a PrereqMatchVocab that the runtime consumes
// via evaluatePrerequisiteCheck. Per klappy://canon/principles/cache-fetches-
// and-parses, this is a parse product: the Set is the stemmed form of the
// canon's vocabulary and is cached alongside the rest of the prereq struct.
function parseCheckColumn(check: string): PrereqMatchVocab {
  const quotedRegex = /"([^"]+)"/g;
  const stemmedTokens = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = quotedRegex.exec(check)) !== null) {
    // Tokenize each quoted keyword or phrase — multi-word phrases like
    // "according to" contribute multiple stems. Stop-word filtering is
    // disabled (empty Set) because canon vocab includes stop-word
    // keywords — `from` in source-named, `to` in `according to`, etc.
    // The pre-refactor regex evaluator matched these literally as
    // `\bfrom\b` against raw input; dropping them here would silently
    // break the strictly-additive invariant. The runtime call site uses
    // the same empty stop-word set on inputStems so both sides share
    // shape. Stemming still applies (problems → problem, considered →
    // consid). Per Bugbot finding on PR #120 (medium severity) and
    // PR #121 (carried forward).
    for (const stem of tokenize(m[1], new Set())) {
      stemmedTokens.add(stem);
    }
  }
  return {
    stemmedTokens,
    hasURLCheck: /\bURL\b/i.test(check),
    hasNumericCheck: /\bnumeric\b/i.test(check),
    hasProperNounCheck: /\bproper-?noun\b/i.test(check),
    hasCitationCheck: /\bcitation\b/i.test(check),
  };
}

// Governance-driven check evaluator — runtime pairing for parseCheckColumn.
// Per PRD D5 (split-by-fit): prereq evaluation is independent gap-or-not per
// prereq, not ranked. Stemmed set intersection is the fit-to-problem matcher
// and catches morphological variations that the prior regex cascade missed
// (e.g. "problems identified" now stems to `problem` + `identif` and matches
// a prereq whose vocab includes `problem`). Structural side-tests (URL,
// numeric, proper-noun, citation) preserved from the pre-refactor evaluator
// because they cover cases the keyword vocabulary can't — `source-named`
// inputs like "here's the URL: https://..." have no stemmed overlap with the
// vocab `per / according to / from / source: / who said / where i read` but
// the URL structural test catches them. Strictly additive over the prior
// regex: every input that matched pre-refactor still matches post-refactor.
function evaluatePrerequisiteCheck(
  inputStems: Set<string>,
  rawInput: string,
  prereq: PrereqMatchVocab,
): boolean {
  // Token match — stemmed set intersection.
  for (const s of prereq.stemmedTokens) {
    if (inputStems.has(s)) return true;
  }
  // Structural tests — preserved from pre-refactor evaluator. Check against
  // the raw input because these patterns are inherently case- and shape-
  // sensitive (URLs, proper-noun capitalization, bracketed citations).
  if (prereq.hasURLCheck && /https?:\/\//.test(rawInput)) return true;
  if (prereq.hasNumericCheck && /\d/.test(rawInput)) return true;
  if (prereq.hasProperNounCheck && /\b[A-Z][a-z]+\s+[A-Z]/.test(rawInput)) return true;
  if (prereq.hasCitationCheck && /\[\d+\]|\bper\s+[A-Z]|\baccording to\b/i.test(rawInput)) {
    return true;
  }
  // Conservative fallback: prereqs whose check description had NO quoted
  // keywords AND NO structural hints pass on any non-trivial input. This
  // preserves the pre-refactor fallback behavior (`input.trim().length >= 20`).
  if (
    prereq.stemmedTokens.size === 0 &&
    !prereq.hasURLCheck &&
    !prereq.hasNumericCheck &&
    !prereq.hasProperNounCheck &&
    !prereq.hasCitationCheck
  ) {
    return rawInput.trim().length >= 20;
  }
  return false;
}

async function runGateAction(
  input: string,
  context: string | undefined,
  fetcher: KnowledgeBaseFetcher,
  knowledgeBaseUrl?: string,
  state?: OddkitState,
): Promise<ActionResult> {
  const startMs = Date.now();
  const fullInput = context ? `${input}\n${context}` : input;

  // Load governance in parallel. Each helper returns a { <domainNoun>, source }
  // tuple per PRD D3; aggregate strictly per D1 (any helper minimal → aggregate
  // minimal). Per PRD D5: transitions use BM25 (ranking problem); prereqs use
  // stemmed set intersection (independent gap-or-not, avoids BM25 IDF-negative
  // pathology on small shared-vocabulary corpora).
  const [
    { transitions, source: transitionsSource },
    { prerequisites, source: prereqsSource },
  ] = await Promise.all([
    fetchGateTransitions(fetcher, knowledgeBaseUrl),
    fetchGatePrerequisites(fetcher, knowledgeBaseUrl),
  ]);

  // Strict union per canon/constraints/core-governance-baseline. Two-tier
  // today (workers/baseline/ not shipped); expands additively to include
  // "bundled" when that pipeline ships.
  const governanceSource: "knowledge_base" | "minimal" =
    [transitionsSource, prereqsSource].some((s) => s === "minimal")
      ? "minimal"
      : "knowledge_base";

  // Per PRD D4: two peer governance URIs (not singular), alphabetical by
  // path-tail. Shape divergence from encode's singular governance_uri is
  // by design — gate's two files are peers with no hierarchy. Shape parity
  // with challenge's governance_uris plural array; gate's is structurally
  // cleaner because both entries point to peer single files (challenge's
  // array mixed a directory anchor with three files).
  const governanceUris = [
    "klappy://odd/gate/prerequisites",
    "klappy://odd/gate/transitions",
  ];

  // Transition detection via BM25 per PRD D5. Index is built inline from
  // the cached governance array (per PRD D9 — microsecond derivation, not
  // cached separately). Top hit with score > 0 wins; rowOrder breaks ties
  // deterministically when two transitions score identically.
  const bm25Docs = transitions.map((t) => ({ id: t.key, text: t.detectionText }));
  const transitionIndex = buildBM25Index(bm25Docs);
  const hits = searchBM25(transitionIndex, fullInput, transitions.length);

  let matchedTransition: TransitionDef | null = null;
  if (hits.length > 0 && hits[0].score > 0) {
    const topScore = hits[0].score;
    const tiedIds = new Set(hits.filter((h) => h.score === topScore).map((h) => h.id));
    const tiedTransitions = transitions
      .filter((t) => tiedIds.has(t.key))
      .sort((a, b) => a.rowOrder - b.rowOrder);
    matchedTransition = tiedTransitions[0] ?? null;
  }

  const transition = matchedTransition
    ? { from: matchedTransition.from, to: matchedTransition.to }
    : { from: "unknown", to: "unknown" };

  // Prereq evaluation via stemmed set intersection per PRD D5. Each prereq
  // evaluates independently — pass if any stemmed input token matches any
  // stemmed check term; no ranking, no scoring. Eliminates BM25's IDF-
  // negative pathology on small corpora with shared vocabulary.
  const inputStems = new Set(tokenize(fullInput));
  const prereqById = new Map(prerequisites.map((p) => [p.id, p]));

  const met: string[] = [];
  const unmet: string[] = [];
  const unknown: string[] = [];

  if (matchedTransition) {
    for (const prereqId of matchedTransition.prereqIds) {
      const prereq = prereqById.get(prereqId);
      if (!prereq) {
        // Governance error: transition references a prereq id not defined in
        // odd/gate/prerequisites.md. Surface as unknown rather than crash so
        // partial canon states remain diagnosable.
        unknown.push(`(unknown prereq id: ${prereqId})`);
        continue;
      }
      const hasMatch = Array.from(prereq.stemmedTokens).some((s) => inputStems.has(s));
      if (hasMatch) {
        met.push(prereq.id);
      } else {
        unmet.push(prereq.gapMessage);
      }
    }
  }

  const gateStatus = unmet.length > 0 ? "NOT_READY" : "PASS";
  const requiredTotal = matchedTransition ? matchedTransition.prereqIds.length : 0;

  // Update state
  const updatedState = state ? initState(state) : undefined;
  if (updatedState && gateStatus === "PASS") {
    updatedState.gates_passed.push(`${transition.from} → ${transition.to}`);
    if (transition.to === "planning" || transition.to === "execution") {
      updatedState.phase = transition.to as OddkitState["phase"];
    }
  }

  const lines = [`Gate: ${gateStatus} (${transition.from} → ${transition.to})`, ""];
  lines.push(`Prerequisites: ${met.length}/${requiredTotal} required met`, "");
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
  if (unknown.length > 0) {
    lines.push("Unknown (governance errors):");
    for (const u of unknown) lines.push(`  ? ${u}`);
    lines.push("");
  }

  const debug: Record<string, unknown> = {
    duration_ms: Date.now() - startMs,
    generated_at: new Date().toISOString(),
  };
  if (knowledgeBaseUrl) {
    debug.knowledge_base_url = knowledgeBaseUrl;
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
        required_total: requiredTotal,
      },
      governance_source: governanceSource,
      governance_uris: governanceUris,
    },
    state: updatedState,
    assistant_text: lines.join("\n").trim(),
    debug,
  };
}

async function runEncodeAction(
  input: string,
  context: string | undefined,
  fetcher: KnowledgeBaseFetcher,
  knowledgeBaseUrl?: string,
  state?: OddkitState,
): Promise<ActionResult> {
  const startMs = Date.now();
  // Governance: input generates artifacts; context only informs quality scoring.
  // See: klappy://odd/encoding-types/how-to-write-encoding-types#context-vs-input
  // Do not pass fullInput to parsers — that would create separate artifacts
  // for each context paragraph instead of letting context inform scoring.

  const { types, source: governanceSource } = await discoverEncodingTypes(fetcher, knowledgeBaseUrl);

  // Detection cascade:
  //   1. DOLCHEO prefix-tagged batch ([D] / [O] / [L] / [C] / [H] / [E] / [O-open]) — batch-mode canary
  //   2. TSV-structured input (LETTER\tTITLE\tBODY per line) — legacy
  //   3. Unstructured paragraphs — trigger-word classification
  const prefixed = isPrefixedBatchInput(input);
  const structured = !prefixed && isStructuredInput(input);
  const artifacts = prefixed
    ? parsePrefixedBatchInput(input, types)
    : structured
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
    const scored: {
      title: string; type: string; typeName: string; content: string;
      fields: string[]; quality: ReturnType<typeof scoreArtifactQuality>;
      facet?: string; priority_band?: string;
    } = {
      title: a.title, type: a.type, typeName: a.typeName,
      content: a.body, fields: a.fields, quality,
    };
    if (a.facet) scored.facet = a.facet;
    if (a.priority_band) scored.priority_band = a.priority_band;
    return scored;
  });

  // Update state — track all encoded type letters (Open facet uses same letter)
  const updatedState = state ? initState(state) : undefined;
  if (updatedState) {
    for (const a of artifacts) {
      const tag = a.facet === "open" ? `${a.type}-open:${a.title}` : `${a.type}:${a.title}`;
      updatedState.decisions_encoded.push(tag);
    }
  }

  // Build assistant_text as markdown with per-artifact sections
  const lines: string[] = [
    `## Encoded ${scoredArtifacts.length} artifact${scoredArtifacts.length !== 1 ? "s" : ""} (governance: ${governanceSource})`,
    "",
  ];
  for (const a of scoredArtifacts) {
    const header = a.facet === "open"
      ? `### [${a.type}-open${a.priority_band ? ` ${a.priority_band}` : ""}] ${a.typeName}: ${a.title}`
      : `### [${a.type}] ${a.typeName}: ${a.title}`;
    lines.push(header);
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
      governance_source: governanceSource,
      governance_uri: "klappy://canon/definitions/dolcheo-vocabulary",
      persist_required: true,
      next_action: "Save these artifacts to storage. Encode does NOT persist.",
    },
    state: updatedState,
    assistant_text: lines.join("\n").trim(),
    debug: {
      duration_ms: Date.now() - startMs,
      generated_at: new Date().toISOString(),
      knowledge_base_url: knowledgeBaseUrl,
    },
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
  "resolve",
  "catalog",
  "validate",
  "preflight",
  "version",
  "cleanup_storage",
] as const;

export async function handleUnifiedAction(params: UnifiedParams): Promise<OddkitEnvelope> {
  const { action, input, context, mode, knowledge_base_url, include_metadata, section, sort_by, limit, offset, filter_epoch, state, env, tracer } = params;

  if (!VALID_ACTIONS.includes(action as (typeof VALID_ACTIONS)[number])) {
    return {
      action: "error",
      result: { error: `Unknown action: ${action}. Valid: ${VALID_ACTIONS.join(", ")}` },
      server_time: new Date().toISOString(),
      assistant_text: `Unknown action: ${action}. Valid actions: ${VALID_ACTIONS.join(", ")}`,
      debug: { generated_at: new Date().toISOString() },
    };
  }

  const fetcher = new KnowledgeBaseFetcher(env, tracer);

  try {
    const actionStart = performance.now();
    let result: ActionResult;

    switch (action) {
      case "orient":
        result = await runOrientAction(input, fetcher, knowledge_base_url, state);
        break;
      case "challenge":
        result = await runChallengeAction(input, mode, fetcher, knowledge_base_url, state);
        break;
      case "gate":
        result = await runGateAction(input, context, fetcher, knowledge_base_url, state);
        break;
      case "encode":
        result = await runEncodeAction(input, context, fetcher, knowledge_base_url, state);
        break;
      case "search":
        result = await runSearch(input, fetcher, knowledge_base_url, state, include_metadata);
        break;
      case "get":
        result = await runGet(input, fetcher, knowledge_base_url, state, include_metadata, section);
        break;
      case "resolve":
        result = await runResolve(input, fetcher, knowledge_base_url, state);
        break;
      case "catalog":
        result = await runCatalog(fetcher, knowledge_base_url, state, { sort_by, limit, offset, filter_epoch });
        break;
      case "validate":
        result = await runValidate(input, state);
        break;
      case "preflight":
        result = await runPreflight(input, fetcher, knowledge_base_url, state);
        break;
      case "version":
        result = runVersion(env);
        break;
      case "cleanup_storage":
        result = await runCleanupStorage(fetcher, knowledge_base_url);
        break;
      default:
        result = await runSearch(input, fetcher, knowledge_base_url, state);
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
        knowledge_base_url,
        baseline_url: env.DEFAULT_KNOWLEDGE_BASE_URL,
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
  const { message, action: explicitAction, env, knowledgeBaseUrl } = options;
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
    knowledge_base_url: knowledgeBaseUrl,
    env,
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Backward-compat: individual action exports (used by old tool routing)
// ──────────────────────────────────────────────────────────────────────────────

interface OrientOptions {
  input: string;
  env: Env;
  knowledgeBaseUrl?: string;
}
interface ChallengeOptions {
  input: string;
  mode?: string;
  env: Env;
  knowledgeBaseUrl?: string;
}
interface GateOptions {
  input: string;
  context?: string;
  env: Env;
  knowledgeBaseUrl?: string;
}
interface EncodeOptions {
  input: string;
  context?: string;
  env: Env;
  knowledgeBaseUrl?: string;
}

/** @deprecated Use handleUnifiedAction({ action: "orient", ... }) */
export async function runOrientActionCompat(options: OrientOptions): Promise<OddkitEnvelope> {
  return handleUnifiedAction({
    action: "orient",
    input: options.input,
    knowledge_base_url: options.knowledgeBaseUrl,
    env: options.env,
  });
}

/** @deprecated Use handleUnifiedAction({ action: "challenge", ... }) */
export async function runChallengeActionCompat(options: ChallengeOptions): Promise<OddkitEnvelope> {
  return handleUnifiedAction({
    action: "challenge",
    input: options.input,
    mode: options.mode,
    knowledge_base_url: options.knowledgeBaseUrl,
    env: options.env,
  });
}

/** @deprecated Use handleUnifiedAction({ action: "gate", ... }) */
export async function runGateActionCompat(options: GateOptions): Promise<OddkitEnvelope> {
  return handleUnifiedAction({
    action: "gate",
    input: options.input,
    context: options.context,
    knowledge_base_url: options.knowledgeBaseUrl,
    env: options.env,
  });
}

/** @deprecated Use handleUnifiedAction({ action: "encode", ... }) */
export async function runEncodeActionCompat(options: EncodeOptions): Promise<OddkitEnvelope> {
  return handleUnifiedAction({
    action: "encode",
    input: options.input,
    context: options.context,
    knowledge_base_url: options.knowledgeBaseUrl,
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
