/**
 * Orient task — assess a goal/idea/situation against epistemic modes.
 *
 * Determines which mode (exploration/planning/execution) the user is in,
 * surfaces unresolved items, assumptions, and questions that need answering.
 *
 * Queries canon at runtime for epistemic mode definitions and constraints.
 * Does NOT carry embedded knowledge — intelligence is in framing the query.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { buildIndex, loadIndex, saveIndex } from "../index/buildIndex.js";
import { ensureBaselineRepo } from "../baseline/ensureBaselineRepo.js";
import { applySupersedes } from "../resolve/applySupersedes.js";
import { tokenize, scoreDocument, findBestHeading } from "../utils/scoring.js";
import { extractQuote, formatCitation, countWords } from "../utils/slicing.js";
import { writeLast } from "../state/last.js";

/**
 * Extract the creed from canon/values/orientation.md content.
 * Parses the "## The Creed" section and returns the 5 creed lines.
 * Returns null if the section is not found.
 */
function extractCreedFromContent(content) {
  const lines = content.split("\n");
  const startIdx = lines.findIndex((l) => /^##\s+The Creed/.test(l));
  if (startIdx === -1) return null;
  const creedLines = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break; // next heading
    const trimmed = lines[i].trim();
    // Collect non-empty, non-heading, non-blockquote lines as creed lines
    if (trimmed && !trimmed.startsWith(">") && !trimmed.startsWith("#") && !trimmed.startsWith("<!--") && !/^-{3,}$/.test(trimmed)) {
      creedLines.push(trimmed);
    }
  }
  return creedLines.length > 0 ? creedLines : null;
}

/**
 * Read the creed from baseline cache.
 * Returns array of creed lines, or null if unavailable.
 */
function readCreedFromBaseline(baselineRoot) {
  if (!baselineRoot) return null;
  const orientPath = join(baselineRoot, "canon", "values", "orientation.md");
  if (!existsSync(orientPath)) return null;
  try {
    const content = readFileSync(orientPath, "utf-8");
    return extractCreedFromContent(content);
  } catch {
    return null;
  }
}

/**
 * Mode detection signals — keywords and patterns that suggest each mode.
 * Used to infer which epistemic mode the user is likely in based on their input.
 */
const MODE_SIGNALS = {
  exploration: {
    patterns: [
      /\b(what if|wonder|explore|brainstorm|idea|thinking about|consider|curious)\b/i,
      /\b(might|could|maybe|possibly|potentially|hypothetically)\b/i,
      /\b(understand|learn|discover|investigate|research|look into)\b/i,
      /\?/,
    ],
    weight: 0,
  },
  planning: {
    patterns: [
      /\b(plan|design|architect|structure|organize|outline|strategy)\b/i,
      /\b(decide|choose|select|pick|determine|evaluate|compare)\b/i,
      /\b(requirements?|constraints?|scope|specification|criteria)\b/i,
      /\b(before|prepare|ready to|getting ready|setting up)\b/i,
    ],
    weight: 0,
  },
  execution: {
    patterns: [
      /\b(implement|build|code|write|create|deploy|ship|release)\b/i,
      /\b(fix|debug|resolve|patch|update|modify|change|refactor)\b/i,
      /\b(test|verify|validate|confirm|check|ensure)\b/i,
      /\b(doing|building|working on|in progress|currently)\b/i,
    ],
    weight: 0,
  },
};

/**
 * Detect epistemic mode from input text.
 * Returns { mode, confidence, signals } where confidence is "low"|"partial"|"strong".
 */
function detectMode(input) {
  if (!input || typeof input !== "string") {
    return { mode: "exploration", confidence: "low", signals: {} };
  }

  const scores = {};
  const matchedSignals = {};

  for (const [mode, config] of Object.entries(MODE_SIGNALS)) {
    let score = 0;
    const matched = [];
    for (const pattern of config.patterns) {
      if (pattern.test(input)) {
        score++;
        matched.push(pattern.source);
      }
    }
    scores[mode] = score;
    matchedSignals[mode] = matched;
  }

  // Find dominant mode
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const topMode = sorted[0][0];
  const topScore = sorted[0][1];
  const secondScore = sorted.length > 1 ? sorted[1][1] : 0;

  // Determine confidence based on signal strength and margin
  let confidence;
  if (topScore === 0) {
    confidence = "low";
  } else if (topScore - secondScore >= 2) {
    confidence = "strong";
  } else if (topScore >= 2) {
    confidence = "partial";
  } else {
    confidence = "low";
  }

  return { mode: topMode, confidence, signals: matchedSignals };
}

/**
 * Extract assumptions from input text.
 * Looks for implicit assumptions (declarative statements, unstated premises).
 */
function extractAssumptions(input) {
  if (!input) return [];

  const assumptions = [];
  const sentences = input.split(/[.!?\n]+/).filter((s) => s.trim().length > 5);

  for (const sentence of sentences) {
    const trimmed = sentence.trim();

    // Declarative statements without evidence markers
    if (
      /\b(is|are|will|should|must|always|never|everyone|nobody|obviously|clearly)\b/i.test(
        trimmed,
      ) &&
      !trimmed.endsWith("?")
    ) {
      // Skip very short fragments
      if (countWords(trimmed) >= 4) {
        assumptions.push(trimmed);
      }
    }
  }

  return assumptions.slice(0, 5); // Cap at 5
}

/**
 * Generate questions that need answering before progressing.
 */
function generateQuestions(mode, input, canonRefs) {
  const questions = [];

  if (mode === "exploration") {
    questions.push("What specific problem are you trying to solve?");
    questions.push("What constraints or boundaries apply here?");
    questions.push("What would success look like?");
  } else if (mode === "planning") {
    questions.push("What decisions have been locked vs. still open?");
    questions.push("What are the irreversible aspects of this plan?");
    questions.push("What evidence supports this approach over alternatives?");
  } else if (mode === "execution") {
    questions.push("Has the plan been validated against constraints?");
    questions.push("What does the definition of done look like?");
    questions.push("What artifacts will demonstrate completion?");
  }

  // Add canon-informed questions if we have references
  if (canonRefs.length > 0) {
    questions.push(`Have you reviewed: ${canonRefs[0].path}?`);
  }

  return questions;
}

/**
 * Run orient task
 *
 * @param {Object} options
 * @param {string} options.input - Goal, idea, or situation description
 * @param {string} options.repo - Repository root path
 * @param {string} [options.baseline] - Baseline override
 * @returns {Promise<Object>}
 */
export async function runOrient(options) {
  const { input, repo: repoRoot, baseline: baselineOverride } = options;

  if (!input || typeof input !== "string" || input.trim().length === 0) {
    const errorResult = {
      status: "ERROR",
      error: "Input is required: provide a goal, idea, or situation description.",
      debug: { tool: "orient", timestamp: new Date().toISOString() },
    };
    writeLast(errorResult);
    return errorResult;
  }

  // Detect epistemic mode from input
  const modeDetection = detectMode(input);

  // Load index to query canon for relevant docs
  const baseline = await ensureBaselineRepo(baselineOverride);
  const baselineAvailable = !!baseline.root;

  // Read creed from baseline (always included in orient response)
  const creed = readCreedFromBaseline(baseline.root);

  let index = loadIndex(repoRoot);
  if (!index) {
    index = await buildIndex(repoRoot, baselineAvailable ? baseline.root : null);
    saveIndex(index, repoRoot);
  }

  const { filtered: docs } = applySupersedes(index.documents);

  // Query canon for epistemic-relevant docs using the input as query
  const queryTokens = tokenize(input);
  const epistemic = {
    mode_ref: `klappy://canon/epistemic#${modeDetection.mode}`,
    confidence: modeDetection.confidence,
  };

  const scored = docs
    .map((doc) => {
      const { score, signals } = scoreDocument(doc, queryTokens, epistemic);
      return { doc, score, signals };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  // Build canon references with quotes
  const canonRefs = [];
  for (const { doc } of scored) {
    const heading = findBestHeading(doc, queryTokens);
    if (!heading) continue;

    const quoteResult = extractQuote(doc, heading);
    if (!quoteResult || quoteResult.wordCount < 8) continue;

    canonRefs.push({
      path: formatCitation(doc, heading),
      quote: quoteResult.quote,
      origin: doc.origin,
    });

    if (canonRefs.length >= 3) break;
  }

  // Extract assumptions and unresolved items
  const assumptions = extractAssumptions(input);
  const questions = generateQuestions(modeDetection.mode, input, canonRefs);

  // Determine what's unresolved
  const unresolved = [];
  if (modeDetection.confidence === "low") {
    unresolved.push("Epistemic mode is unclear — the input could be exploration or planning");
  }
  if (assumptions.length > 0) {
    unresolved.push(`${assumptions.length} assumption(s) detected that may need validation`);
  }
  if (canonRefs.length === 0) {
    unresolved.push("No directly relevant canon found — this may be outside documented territory");
  }

  const result = {
    status: "ORIENTED",
    creed: creed || null,
    current_mode: modeDetection.mode,
    mode_confidence: modeDetection.confidence,
    mode_signals: modeDetection.signals,
    unresolved,
    assumptions,
    suggested_questions: questions,
    canon_refs: canonRefs,
    debug: {
      tool: "orient",
      reason: "ORIENT_REQUESTED",
      timestamp: new Date().toISOString(),
      repo_root: repoRoot,
      input_preview: input.slice(0, 100),
      query_tokens: queryTokens,
      docs_scored: scored.length,
    },
  };

  writeLast(result);
  return result;
}
