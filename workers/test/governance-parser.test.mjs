#!/usr/bin/env node
/**
 * Parser-fidelity test for governance-driven challenge extraction.
 *
 * Fetches the 11 live governance articles from klappy.dev and runs the same
 * regex patterns used in workers/src/orchestrate.ts to confirm the parsers
 * correctly extract types, questions, prerequisites, vocabulary, and calibration.
 *
 * This is not a worker integration test — it exercises the parser logic
 * outside the Cloudflare runtime. Run pre-PR to verify parser regexes match
 * real-world article structure.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

// Articles to test against — these MUST exist in the local clone of klappy.dev
// or we fetch from raw.githubusercontent.com
// Default to main; override via KLAPPYDEV_RAW env var when testing against
// an unmerged feature branch (e.g. while klappy.dev#100 is still open).
const KLAPPYDEV_RAW =
  process.env.KLAPPYDEV_RAW || "https://raw.githubusercontent.com/klappy/klappy.dev/main";
const ARTICLE_PATHS = {
  meta: "odd/challenge-types/how-to-write-challenge-types.md",
  strongClaim: "odd/challenge-types/strong-claim.md",
  proposal: "odd/challenge-types/proposal.md",
  assumption: "odd/challenge-types/assumption.md",
  observation: "odd/challenge-types/observation.md",
  patternCoinage: "odd/challenge-types/pattern-coinage.md",
  comparativePositioning: "odd/challenge-types/comparative-positioning.md",
  principleExtraction: "odd/challenge-types/principle-extraction.md",
  basePrerequisites: "odd/challenge/base-prerequisites.md",
  normativeVocabulary: "odd/challenge/normative-vocabulary.md",
  stakesCalibration: "odd/challenge/stakes-calibration.md",
};

async function fetchArticle(path) {
  const url = `${KLAPPYDEV_RAW}/${path}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
  return r.text();
}

// ──────────────────────────────────────────────────────────────────────────
// Parser logic — verbatim copies of the regexes in workers/src/orchestrate.ts
// ──────────────────────────────────────────────────────────────────────────

function parseChallengeType(content) {
  const slugMatch = content.match(/\|\s*Slug\s*\|\s*([^|]+)\s*\|/);
  const nameMatch = content.match(/\|\s*Name\s*\|\s*([^|]+)\s*\|/);
  if (!slugMatch) return null;
  const slug = slugMatch[1].trim();
  const name = nameMatch ? nameMatch[1].trim() : slug;

  const blockquoteMatch = content.match(/^#\s[^\n]+\n+>\s*([^\n]+(?:\n>\s*[^\n]+)*)/m);
  const blockquote = blockquoteMatch
    ? blockquoteMatch[1].replace(/\n>\s*/g, " ").trim()
    : "";

  const detectionSection = content.match(
    /## Detection Patterns[\s\S]*?```\n([\s\S]*?)\n```/,
  );
  const triggerWords = detectionSection
    ? detectionSection[1].split(",").map((w) => w.trim()).filter((w) => w.length > 0)
    : [];

  const questionsSection = content.match(
    /## Challenge Questions[\s\S]*?\| Question[\s\S]*?\|[-|\s]+\|\n([\s\S]*?)(?=\n\n|\n##|$)/,
  );
  const questions = [];
  if (questionsSection) {
    for (const row of questionsSection[1].split("\n").filter((r) => r.includes("|"))) {
      const cols = row.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
      if (cols.length >= 2) questions.push({ question: cols[0], tier: cols[1] });
    }
  }

  const prereqSection = content.match(
    /## Prerequisite Overlays[\s\S]*?\| Prerequisite[\s\S]*?\|[-|\s]+\|\n([\s\S]*?)(?=\n\n|\n##|$)/,
  );
  const prerequisiteOverlays = [];
  if (prereqSection) {
    for (const row of prereqSection[1].split("\n").filter((r) => r.includes("|"))) {
      const cols = row.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
      if (cols.length >= 3) {
        prerequisiteOverlays.push({
          prerequisite: cols[0],
          check: cols[1],
          gapMessage: cols[2].replace(/^"|"$/g, "").replace(/\{name\}/g, name),
        });
      }
    }
  }

  const reframingsSection = content.match(/## Suggested Reframings[\s\S]*?\n((?:-\s+[^\n]+\n?)+)/);
  const reframings = [];
  if (reframingsSection) {
    for (const line of reframingsSection[1].split("\n")) {
      const m = line.match(/^-\s+(.+)$/);
      if (m) reframings.push(m[1].trim());
    }
  }

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  let fallback = false;
  if (fmMatch) {
    fallback = /^fallback:\s*true\s*$/m.test(fmMatch[1]);
  }

  return { slug, name, blockquote, triggerWords, questions, prerequisiteOverlays, reframings, fallback };
}

function parseBasePrereqs(content) {
  const section = content.match(
    /## Prerequisite Overlays[\s\S]*?\| Prerequisite[\s\S]*?\|[-|\s]+\|\n([\s\S]*?)(?=\n\n|\n##|$)/,
  );
  const result = [];
  if (section) {
    for (const row of section[1].split("\n").filter((r) => r.includes("|"))) {
      const cols = row.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
      if (cols.length >= 3) {
        result.push({ prerequisite: cols[0], check: cols[1], gapMessage: cols[2].replace(/^"|"$/g, "") });
      }
    }
  }
  return result;
}

function parseNormativeVocab(content) {
  const caseSensitive = [];
  const caseInsensitive = [];
  const sections = content.split(/###\s+/);
  for (const section of sections) {
    const isCS = /RFC 2119|Directive Language/i.test(section.split("\n")[0] || "");
    const tableMatch = section.match(/\|\s*(?:Word|Phrase)\s*\|[\s\S]*?\|[-|\s]+\|\n([\s\S]*?)(?=\n\n|\n##|$)/);
    if (!tableMatch) continue;
    for (const row of tableMatch[1].split("\n").filter((r) => r.includes("|"))) {
      const cols = row.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
      if (cols.length >= 2) {
        if (isCS) caseSensitive.push(cols[0]);
        else caseInsensitive.push(cols[0]);
      }
    }
  }
  return { caseSensitive, caseInsensitive };
}

function parseStakesCalibration(content) {
  const tableMatch = content.match(
    /## Stakes Calibration[\s\S]*?\| Mode[\s\S]*?\|[-|\s]+\|\n([\s\S]*?)(?=\n\n|\n##|$)/,
  );
  const byMode = new Map();
  if (tableMatch) {
    for (const row of tableMatch[1].split("\n").filter((r) => r.includes("|"))) {
      const cols = row.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
      if (cols.length >= 4) {
        const tiersRaw = cols[1].toLowerCase().trim();
        const isNone = tiersRaw === "none" || tiersRaw.startsWith("none ") || tiersRaw.startsWith("none(");
        const tiers = isNone ? [] : tiersRaw.split(",").map((t) => t.trim()).filter((t) => t);
        byMode.set(cols[0].toLowerCase(), { tiers, strictness: cols[2], surfacing: cols[3] });
      }
    }
  }
  return byMode;
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(name, cond, detail = "") {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); failed++; }
}

async function run() {
  console.log("Fetching 11 governance articles from klappy.dev...\n");

  const articles = {};
  for (const [key, path] of Object.entries(ARTICLE_PATHS)) {
    articles[key] = await fetchArticle(path);
  }

  console.log("─── Test 1: Challenge type parsing ───");
  const types = [];
  for (const key of ["strongClaim", "proposal", "assumption", "observation", "patternCoinage", "comparativePositioning", "principleExtraction"]) {
    const t = parseChallengeType(articles[key]);
    types.push(t);
    ok(`${key} parses`, t !== null);
    if (t) {
      ok(`${key} has slug`, t.slug.length > 0, `got "${t.slug}"`);
      ok(`${key} has name`, t.name.length > 0, `got "${t.name}"`);
      ok(`${key} has blockquote`, t.blockquote.length > 20, `got ${t.blockquote.length} chars`);
      ok(`${key} has trigger words`, t.triggerWords.length >= 3, `got ${t.triggerWords.length}`);
      ok(`${key} has questions`, t.questions.length >= 2, `got ${t.questions.length}`);
      ok(`${key} questions have tiers`, t.questions.every((q) => ["baseline", "elevated", "rigorous"].includes(q.tier)), `tiers: ${[...new Set(t.questions.map((q) => q.tier))].join(",")}`);
      ok(`${key} has prerequisite overlays`, t.prerequisiteOverlays.length >= 1, `got ${t.prerequisiteOverlays.length}`);
      ok(`${key} has reframings`, t.reframings.length >= 1, `got ${t.reframings.length}`);
    }
  }

  console.log("\n─── Test 2: Fallback resolution ───");
  const observation = types.find((t) => t && t.slug === "observation");
  ok("observation has fallback: true", observation && observation.fallback === true);
  const otherTypes = types.filter((t) => t && t.slug !== "observation");
  ok("non-fallback types do not have fallback: true", otherTypes.every((t) => !t.fallback));

  console.log("\n─── Test 3: BM25 detection with stemming ───");
  // Build the per-type BM25 index the same way the worker does
  const { buildBM25Index, searchBM25, stem } = await import("../src/bm25.ts").catch(() =>
    import("../src/bm25.js"),
  );
  const detectionDocs = types
    .filter((t) => t)
    .map((t) => ({
      id: t.slug,
      text: [t.triggerWords.join(" "), t.blockquote].filter((s) => s.length > 0).join(" "),
    }));
  // Stop words come from the `## Detection Noise` section of normative-vocabulary.md
  // (governance), exactly the same way the worker reads them. No hardcoded
  // duplicate in this test — drift would mean the test passes while production fails.
  const noiseMatch = articles.normativeVocabulary.match(
    /## Detection Noise[\s\S]*?```\n([\s\S]*?)\n```/,
  );
  const stopWords = new Set();
  if (noiseMatch) {
    for (const word of noiseMatch[1].split(/[,\n]/)) {
      const w = word.trim().toLowerCase();
      if (w.length > 0) stopWords.add(w);
    }
  }
  ok(
    "Detection Noise section parses non-empty stop word set",
    stopWords.size > 0,
    `parsed ${stopWords.size} stop words`,
  );
  ok(
    "Detection Noise excludes modal verbs (signal preservation)",
    !stopWords.has("must") && !stopWords.has("should") && !stopWords.has("not"),
    `must=${stopWords.has("must")} should=${stopWords.has("should")} not=${stopWords.has("not")}`,
  );
  ok(
    "Detection Noise includes common filler",
    stopWords.has("the") && stopWords.has("of") && stopWords.has("in"),
  );
  const bm25 = buildBM25Index(detectionDocs, stopWords);

  // Each type's first trigger word should still match its own type
  for (const t of types) {
    if (!t) continue;
    const sampleWord = t.triggerWords[0];
    const hits = searchBM25(bm25, sampleWord, types.length);
    ok(
      `${t.slug} matches its first trigger word "${sampleWord}" via BM25`,
      hits.some((h) => h.id === t.slug),
      `top hit was "${hits[0]?.id || "(none)"}" with score ${hits[0]?.score?.toFixed(2) || 0}`,
    );
  }

  console.log("\n─── Test 3b: Stemming defeats the original coin/coining bug ───");
  // The original regex-based approach had "coining" as a trigger but failed on "coin".
  // With stemming, both should reduce to the same root.
  ok(
    `stem("coin") === stem("coining")`,
    stem("coin") === stem("coining"),
    `stem("coin")="${stem("coin")}" stem("coining")="${stem("coining")}"`,
  );
  ok(
    `"coin the term" matches pattern-coinage via BM25`,
    searchBM25(bm25, "coin the term", types.length).some((h) => h.id === "pattern-coinage"),
  );
  ok(
    `"I'm coining a new term" matches pattern-coinage via BM25`,
    searchBM25(bm25, "I'm coining a new term", types.length).some((h) => h.id === "pattern-coinage"),
  );
  ok(
    `"the principles" matches principle-extraction (plural form)`,
    searchBM25(bm25, "the principles", types.length).some((h) => h.id === "principle-extraction"),
  );
  ok(
    `"alternatives proposed" matches proposal (proposed not propose)`,
    searchBM25(bm25, "alternatives proposed", types.length).some((h) => h.id === "proposal"),
  );

  console.log("\n─── Test 4: Multi-match semantics (BM25) ───");
  const compoundInput = "We must always be coining new terms like Vodka Architecture";
  const matched = searchBM25(bm25, compoundInput, types.length);
  ok(
    "compound input fires multiple types via BM25",
    matched.length >= 2,
    `matched: ${matched.map((m) => m.id).join(", ")}`,
  );
  ok("strong-claim fires on 'must always'", matched.some((m) => m.id === "strong-claim"));
  ok("pattern-coinage fires on 'coining'", matched.some((m) => m.id === "pattern-coinage"));

  console.log("\n─── Test 4b: Empty input + irrelevant input do not over-match ───");
  ok(
    "irrelevant input scores no types",
    searchBM25(bm25, "the cat sat on the mat", types.length).length === 0,
    `(would have triggered fallback in runChallengeAction)`,
  );

  console.log("\n─── Test 5: Base prerequisites ───");
  const basePrereqs = parseBasePrereqs(articles.basePrerequisites);
  ok("base prerequisites parse", basePrereqs.length >= 3, `got ${basePrereqs.length}`);
  ok("base includes evidence-cited", basePrereqs.some((p) => p.prerequisite === "evidence-cited"));
  ok("base includes source-named", basePrereqs.some((p) => p.prerequisite === "source-named"));
  ok("base includes confidence-signaled", basePrereqs.some((p) => p.prerequisite === "confidence-signaled"));

  console.log("\n─── Test 6: Normative vocabulary ───");
  const vocab = parseNormativeVocab(articles.normativeVocabulary);
  ok("case-sensitive RFC 2119 words present", vocab.caseSensitive.length >= 4, `got ${vocab.caseSensitive.length}: ${vocab.caseSensitive.slice(0,5).join(",")}`);
  ok("case-insensitive architectural words present", vocab.caseInsensitive.length >= 3, `got ${vocab.caseInsensitive.length}: ${vocab.caseInsensitive.slice(0,5).join(",")}`);
  ok("includes MUST", vocab.caseSensitive.includes("MUST"));
  ok("includes invariant", vocab.caseInsensitive.includes("invariant"));

  console.log("\n─── Test 7: Stakes calibration ───");
  const calib = parseStakesCalibration(articles.stakesCalibration);
  ok("calibration parses 9 modes", calib.size >= 9, `got ${calib.size} modes: ${[...calib.keys()].join(", ")}`);
  ok("voice-dump exists", calib.has("voice-dump"));
  ok("voice-dump has empty tiers (suppression invariant)", calib.get("voice-dump")?.tiers.length === 0);
  ok("planning has baseline+elevated", calib.get("planning")?.tiers.length === 2);
  ok("execution has all three tiers", calib.get("execution")?.tiers.length === 3);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
