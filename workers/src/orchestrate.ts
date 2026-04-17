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

// Governance-driven challenge types (E0008 — mirrors encode pattern from PR #96)
interface ChallengeTypeDef {
  slug: string;
  name: string;
  blockquote: string;
  triggerWords: string[];
  detectionText: string; // triggerWords + blockquote, fed to BM25 indexer
  questions: Array<{ question: string; tier: string }>;
  prerequisiteOverlays: Array<{ prerequisite: string; check: string; gapMessage: string }>;
  reframings: string[];
  fallback: boolean;
}

interface BasePrerequisite {
  prerequisite: string;
  check: string;
  gapMessage: string;
}

interface NormativeVocabulary {
  caseSensitiveRegex: RegExp | null;
  caseInsensitiveRegex: RegExp | null;
  directiveTypes: Map<string, string>;
}

interface StakesModeConfig {
  questionTiers: string[];
  prerequisiteStrictness: string;
  reframingSurfacing: string;
}

interface StakesCalibration {
  byMode: Map<string, StakesModeConfig>;
}

// Stop word set for challenge-type detection. Filters general filler
// (the, of, in, etc.) but deliberately preserves modal verbs, "do/does/did",
// and negation — those are load-bearing signal for strong-claim, proposal,
// and assumption types. Using the default bm25 STOP_WORDS would silently
// strip "must", "should", "shall", "may", "not" and break detection.
const CHALLENGE_STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "of", "in", "to", "for", "with", "on", "at", "by", "from", "as", "into", "through",
  "and", "but", "or", "nor", "if", "then", "than",
  "that", "this", "it", "its", "we", "you", "he", "she", "they",
  // intentionally NOT in this list (kept as signal):
  // must, should, shall, will, would, may, might, can, could, do, does, did,
  // have, has, had, not, no, never, always
]);

let cachedChallengeTypes: ChallengeTypeDef[] | null = null;
let cachedChallengeTypesCanonUrl: string | undefined = undefined;
let cachedChallengeTypeIndex: BM25Index | null = null;
let cachedChallengeTypeIndexCanonUrl: string | undefined = undefined;
let cachedBasePrerequisites: BasePrerequisite[] | null = null;
let cachedBasePrerequisitesCanonUrl: string | undefined = undefined;
let cachedNormativeVocabulary: NormativeVocabulary | null = null;
let cachedNormativeVocabularyCanonUrl: string | undefined = undefined;
let cachedStakesCalibration: StakesCalibration | null = null;
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

// ──────────────────────────────────────────────────────────────────────────────
// E0008 — Governance-driven challenge (mirrors encode pattern from PR #96)
// Four discovery/fetch helpers read canon at runtime rather than hardcoding
// claim types, tensions, prerequisites, and mode calibration in source.
// ──────────────────────────────────────────────────────────────────────────────

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
          const cols = row
            .split("|")
            .map((c: string) => c.trim())
            .filter((c: string) => c.length > 0);
          if (cols.length >= 2) {
            questions.push({ question: cols[0], tier: cols[1].toLowerCase() });
          }
        }
      }

      // Prerequisite Overlays table — rows of (Prerequisite, Check, Gap message)
      const prereqSection = content.match(
        /## Prerequisite Overlays[\s\S]*?\| Prerequisite[\s\S]*?\|[-|\s]+\|\n([\s\S]*?)(?=\n\n|\n##|$)/,
      );
      const prerequisiteOverlays: Array<{
        prerequisite: string;
        check: string;
        gapMessage: string;
      }> = [];
      if (prereqSection) {
        for (const row of prereqSection[1].split("\n").filter((r: string) => r.includes("|"))) {
          const cols = row
            .split("|")
            .map((c: string) => c.trim())
            .filter((c: string) => c.length > 0);
          if (cols.length >= 3) {
            // Substitute {name} placeholder in gap messages
            const gap = cols[2].replace(/^"|"$/g, "").replace(/\{name\}/g, name);
            prerequisiteOverlays.push({
              prerequisite: cols[0],
              check: cols[1],
              gapMessage: gap,
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

  // Build BM25 index over per-type detection text (triggers + blockquote).
  // Stemming handles morphology; IDF weights distinctive trigger terms above filler.
  // CHALLENGE_STOP_WORDS preserves modal verbs and negation as signal — the
  // default bm25 STOP_WORDS would silently strip "must", "should", "not" etc.
  const bm25Docs = types.map((t) => ({ id: t.slug, text: t.detectionText }));
  const bm25Index = buildBM25Index(bm25Docs, CHALLENGE_STOP_WORDS);

  cachedChallengeTypes = types;
  cachedChallengeTypesCanonUrl = canonUrl;
  cachedChallengeTypeIndex = bm25Index;
  cachedChallengeTypeIndexCanonUrl = canonUrl;
  return types;
}

function getChallengeTypeIndex(): BM25Index | null {
  return cachedChallengeTypeIndex;
}

async function fetchBasePrerequisites(
  fetcher: ZipBaselineFetcher,
  canonUrl?: string,
): Promise<BasePrerequisite[]> {
  if (cachedBasePrerequisites && cachedBasePrerequisitesCanonUrl === canonUrl)
    return cachedBasePrerequisites;

  const result: BasePrerequisite[] = [];
  try {
    const content = await fetcher.getFile("odd/challenge/base-prerequisites.md", canonUrl);
    if (content) {
      const prereqSection = content.match(
        /## Prerequisite Overlays[\s\S]*?\| Prerequisite[\s\S]*?\|[-|\s]+\|\n([\s\S]*?)(?=\n\n|\n##|$)/,
      );
      if (prereqSection) {
        for (const row of prereqSection[1].split("\n").filter((r: string) => r.includes("|"))) {
          const cols = row
            .split("|")
            .map((c: string) => c.trim())
            .filter((c: string) => c.length > 0);
          if (cols.length >= 3) {
            result.push({
              prerequisite: cols[0],
              check: cols[1],
              gapMessage: cols[2].replace(/^"|"$/g, ""),
            });
          }
        }
      }
    }
  } catch {
    // Graceful degradation: no base prerequisites article → type overlays only
  }

  cachedBasePrerequisites = result;
  cachedBasePrerequisitesCanonUrl = canonUrl;
  return result;
}

async function fetchNormativeVocabulary(
  fetcher: ZipBaselineFetcher,
  canonUrl?: string,
): Promise<NormativeVocabulary> {
  if (cachedNormativeVocabulary && cachedNormativeVocabularyCanonUrl === canonUrl)
    return cachedNormativeVocabulary;

  const caseSensitiveWords: string[] = [];
  const caseInsensitiveWords: string[] = [];
  const directiveTypes = new Map<string, string>();

  try {
    const content = await fetcher.getFile("odd/challenge/normative-vocabulary.md", canonUrl);
    if (content) {
      // Two sections: one under "RFC 2119" heading (case-sensitive),
      // one under "Architectural Writing" heading (case-insensitive).
      // Each is a markdown table with (Word | Directive type).
      const sections = content.split(/###\s+/);
      for (const section of sections) {
        const isCaseSensitive = /RFC 2119|Directive Language/i.test(section.split("\n")[0] || "");
        const tableMatch = section.match(/\|\s*(?:Word|Phrase)\s*\|[\s\S]*?\|[-|\s]+\|\n([\s\S]*?)(?=\n\n|\n##|$)/);
        if (!tableMatch) continue;
        for (const row of tableMatch[1].split("\n").filter((r: string) => r.includes("|"))) {
          const cols = row
            .split("|")
            .map((c: string) => c.trim())
            .filter((c: string) => c.length > 0);
          if (cols.length >= 2) {
            const phrase = cols[0];
            const dtype = cols[1];
            directiveTypes.set(phrase, dtype);
            if (isCaseSensitive) caseSensitiveWords.push(phrase);
            else caseInsensitiveWords.push(phrase);
          }
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
        )
      : null;
  const caseInsensitiveRegex =
    caseInsensitiveWords.length > 0
      ? new RegExp(
          "(" +
            [...caseInsensitiveWords].sort((a, b) => b.length - a.length).map(escape).join("|") +
            ")",
          "i",
        )
      : null;

  const vocab = { caseSensitiveRegex, caseInsensitiveRegex, directiveTypes };
  cachedNormativeVocabulary = vocab;
  cachedNormativeVocabularyCanonUrl = canonUrl;
  return vocab;
}

async function fetchStakesCalibration(
  fetcher: ZipBaselineFetcher,
  canonUrl?: string,
): Promise<StakesCalibration> {
  if (cachedStakesCalibration && cachedStakesCalibrationCanonUrl === canonUrl)
    return cachedStakesCalibration;

  const byMode = new Map<string, StakesModeConfig>();
  try {
    const content = await fetcher.getFile("odd/challenge/stakes-calibration.md", canonUrl);
    if (content) {
      // Parse the Stakes Calibration table:
      // | Mode | Question tiers surfaced | Prerequisite strictness | Reframings surfaced |
      const tableMatch = content.match(
        /## Stakes Calibration[\s\S]*?\| Mode[\s\S]*?\|[-|\s]+\|\n([\s\S]*?)(?=\n\n|\n##|$)/,
      );
      if (tableMatch) {
        for (const row of tableMatch[1].split("\n").filter((r: string) => r.includes("|"))) {
          const cols = row
            .split("|")
            .map((c: string) => c.trim())
            .filter((c: string) => c.length > 0);
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
  cachedStakesCalibrationCanonUrl = canonUrl;
  return cachedStakesCalibration;
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
  // E0008 — governance-driven challenge caches (mirror PR #96 fix)
  cachedChallengeTypes = null;
  cachedChallengeTypesCanonUrl = undefined;
  cachedChallengeTypeIndex = null;
  cachedChallengeTypeIndexCanonUrl = undefined;
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
  const mode = (modeHint || "planning").toLowerCase();

  // Load governance in parallel
  const [types, basePrereqs, vocab, calibration] = await Promise.all([
    discoverChallengeTypes(fetcher, canonUrl),
    fetchBasePrerequisites(fetcher, canonUrl),
    fetchNormativeVocabulary(fetcher, canonUrl),
    fetchStakesCalibration(fetcher, canonUrl),
  ]);

  const modeConfig = calibration.byMode.get(mode);

  // Detect matching types via BM25 over per-type detection text.
  // Stemming makes "coining" match "coin", "rolled" match "rollback", etc.
  // score > 0 = match (BM25 returns 0 when no stemmed query terms hit).
  // Multi-match preserved: a single input may score against several types.
  // Detection runs BEFORE the voice-dump suppression check so the SUPPRESSED
  // response can still expose `governance` — the model sees what would have
  // fired without surfacing the pressure-test questions.
  const typeIndex = getChallengeTypeIndex();
  const matchedTypes: ChallengeTypeDef[] = [];
  if (typeIndex) {
    const hits = searchBM25(typeIndex, input, types.length);
    const typeBySlug = new Map(types.map((t) => [t.slug, t]));
    for (const hit of hits) {
      const t = typeBySlug.get(hit.id);
      if (t) matchedTypes.push(t);
    }
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
        matched_types: matchedTypes.map((t) => t.slug),
        governance: matchedTypes.map((t) => ({
          slug: t.slug,
          name: t.name,
          description: t.blockquote,
        })),
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
      debug: { duration_ms: Date.now() - startMs, generated_at: new Date().toISOString() },
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
  const surfacedQuestions: string[] = [];
  for (const q of questionMap.values()) {
    if (!modeConfig || modeConfig.questionTiers.length === 0 || modeConfig.questionTiers.includes(q.tier)) {
      surfacedQuestions.push(q.question);
    }
  }

  const strictness = modeConfig?.prerequisiteStrictness?.toLowerCase() || "required";
  const missing: string[] = [];
  for (const p of prereqMap.values()) {
    const passed = evaluatePrerequisiteCheck(input, p.check);
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
  if (surfacing === "none") {
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
  const index = await fetcher.getIndex(canonUrl);
  const results = scoreEntries(index.entries, `constraints challenges risks ${input}`).slice(0, 4);

  const canonConstraints: Array<{ citation: string; quote: string }> = [];
  const tensions: Array<{ type: string; message: string; citation?: string; quote?: string }> = [];
  for (const entry of results) {
    const content = await fetcher.getFile(entry.path, canonUrl);
    if (content) {
      const stripped = content.replace(/^---[\s\S]*?---\n/, "");
      const lines = stripped.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
      const excerpt = lines.slice(0, 2).join(" ").slice(0, 150);
      const citation = `${entry.path}#${entry.title}`;
      canonConstraints.push({ citation, quote: excerpt });

      // Governance-driven tension detection
      if (vocab.caseSensitiveRegex) {
        const m = excerpt.match(vocab.caseSensitiveRegex);
        if (m) {
          const phrase = m[1];
          tensions.push({
            type: vocab.directiveTypes.get(phrase) || "directive",
            message: `Canon ${vocab.directiveTypes.get(phrase) || "directive"} (${phrase}) found in ${entry.path}`,
            citation,
            quote: excerpt,
          });
          continue;
        }
      }
      if (vocab.caseInsensitiveRegex) {
        const m = excerpt.match(vocab.caseInsensitiveRegex);
        if (m) {
          const phrase = m[1];
          const dtype =
            vocab.directiveTypes.get(phrase) ||
            vocab.directiveTypes.get(phrase.toLowerCase()) ||
            "load-bearing-claim";
          tensions.push({
            type: dtype,
            message: `Canon ${dtype} (${phrase}) found in ${entry.path}`,
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
      matched_types: matchedSlugs,
      governance: matchedTypes.map((t) => ({
        slug: t.slug,
        name: t.name,
        description: t.blockquote,
      })),
      tensions,
      missing_prerequisites: missing,
      challenges: surfacedQuestions,
      suggested_reframings: surfacedReframings,
      block_until_addressed: blockUntilAddressed,
      canon_constraints: canonConstraints,
    },
    state: updatedState,
    assistant_text: lines.join("\n").trim(),
    debug: { duration_ms: Date.now() - startMs, generated_at: new Date().toISOString() },
  };
}

// Governance-driven check evaluator — interprets natural-language `check` strings
// from ## Prerequisite Overlays tables. Uses cheap heuristics: substring matching
// against quoted keywords in the check description, plus a few special-case patterns.
function evaluatePrerequisiteCheck(input: string, check: string): boolean {
  // Extract quoted keywords like "evidence", "observed", "alternative"
  const quotedKeywords: string[] = [];
  const quotedRegex = /"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = quotedRegex.exec(check)) !== null) {
    quotedKeywords.push(m[1]);
  }

  if (quotedKeywords.length > 0) {
    // Pass if ANY quoted keyword appears in input (case-insensitive, word-boundary where possible)
    for (const kw of quotedKeywords) {
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Use word-boundary for single words, substring for phrases
      const pattern = /^\w+$/.test(kw) ? new RegExp("\\b" + escaped + "\\b", "i") : new RegExp(escaped, "i");
      if (pattern.test(input)) return true;
    }
    // Special-case check descriptions that mention URLs, citations, numeric markers
    if (/\bURL\b/i.test(check) && /https?:\/\//.test(input)) return true;
    if (/numeric/i.test(check) && /\d/.test(input)) return true;
    if (/proper-?noun/i.test(check) && /\b[A-Z][a-z]+\s+[A-Z]/.test(input)) return true;
    if (/citation/i.test(check) && /\[\d+\]|\bper\s+[A-Z]|\baccording to\b/i.test(input)) return true;
    return false;
  }

  // No quoted keywords: conservative fallback — passes if input is non-trivial
  return input.trim().length >= 20;
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
