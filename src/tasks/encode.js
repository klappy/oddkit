/**
 * Encode task — structure a decision, insight, or boundary as a durable record.
 *
 * Validates that the input has sufficient justification and clarity to
 * prevent future re-litigation. Structures it per encode-epistemic-decisions
 * canon format.
 *
 * Does NOT carry embedded knowledge — queries canon at runtime.
 */

import { buildIndex, loadIndex, saveIndex } from "../index/buildIndex.js";
import { ensureBaselineRepo } from "../baseline/ensureBaselineRepo.js";
import { applySupersedes } from "../resolve/applySupersedes.js";
import { tokenize, scoreDocument, findBestHeading } from "../utils/scoring.js";
import { extractQuote, formatCitation, countWords } from "../utils/slicing.js";
import { writeLast } from "../state/last.js";

/**
 * Detect the type of thing being encoded.
 * Returns: "decision" | "insight" | "boundary" | "override"
 */
function detectEncodeType(input) {
  const lower = input.toLowerCase();

  if (/\b(decided|decision|chose|choosing|selected|committed to|going with)\b/i.test(input)) {
    return "decision";
  }
  if (/\b(learned|insight|realized|discovered|found that|turns out)\b/i.test(input)) {
    return "insight";
  }
  if (/\b(boundary|limit|constraint|rule|prohibition|must not|never)\b/i.test(input)) {
    return "boundary";
  }
  if (/\b(override|exception|despite|even though|notwithstanding)\b/i.test(input)) {
    return "override";
  }

  return "decision"; // Default
}

/**
 * Extract a title from the input.
 * Uses the first sentence or a summary.
 */
function extractTitle(input) {
  // First sentence
  const firstSentence = input.split(/[.!?\n]/)[0]?.trim();
  if (firstSentence && countWords(firstSentence) <= 12) {
    return firstSentence;
  }

  // First N words
  const words = input.split(/\s+/).slice(0, 8);
  return words.join(" ") + "...";
}

/**
 * Extract rationale from input — the "because" or "why" portion.
 */
function extractRationale(input) {
  // Look for explicit rationale markers
  const rationalePatterns = [
    /because\s+(.+?)(?:\.|$)/i,
    /reason(?:ing)?:\s*(.+?)(?:\.|$)/i,
    /due to\s+(.+?)(?:\.|$)/i,
    /since\s+(.+?)(?:\.|$)/i,
    /this (?:is|was) (?:because|due to)\s+(.+?)(?:\.|$)/i,
  ];

  for (const pattern of rationalePatterns) {
    const match = input.match(pattern);
    if (match && match[1] && countWords(match[1]) >= 3) {
      return match[1].trim();
    }
  }

  return null;
}

/**
 * Extract constraints mentioned in the input.
 */
function extractConstraints(input) {
  const constraints = [];
  const sentences = input.split(/[.!?\n]+/).filter((s) => s.trim().length > 5);

  for (const sentence of sentences) {
    if (
      /\b(must|shall|required|always|never|constraint|rule|cannot|must not)\b/i.test(sentence)
    ) {
      constraints.push(sentence.trim());
    }
  }

  return constraints.slice(0, 5);
}

/**
 * Assess the quality of the decision record.
 * Returns { score, gaps, suggestions }
 */
function assessQuality(input, encodeType, rationale, constraints) {
  const gaps = [];
  const suggestions = [];
  let score = 0;
  const maxScore = 5;

  // 1. Has a clear statement
  if (countWords(input) >= 10) {
    score++;
  } else {
    gaps.push("Decision statement is too brief — expand what was decided");
  }

  // 2. Has rationale
  if (rationale) {
    score++;
  } else {
    gaps.push("No rationale detected — add 'because...' to explain why");
    suggestions.push("Add explicit rationale: why this decision and not alternatives");
  }

  // 3. Has constraints
  if (constraints.length > 0) {
    score++;
  } else {
    suggestions.push("Consider adding constraints: what boundaries does this create?");
  }

  // 4. Addresses alternatives (for decisions)
  if (encodeType === "decision") {
    if (/\b(alternative|instead|option|versus|vs|rather than|over)\b/i.test(input)) {
      score++;
    } else {
      suggestions.push("Document what alternatives were considered and rejected");
    }
  } else {
    score++; // Non-decisions don't need alternatives
  }

  // 5. Addresses reversibility
  if (/\b(irreversib|reversib|can.t undo|one-way|temporary|permanent|until)\b/i.test(input)) {
    score++;
  } else {
    suggestions.push("Note whether this is reversible or permanent");
  }

  const qualityLevel =
    score >= 4 ? "strong" : score >= 3 ? "adequate" : score >= 2 ? "weak" : "insufficient";

  return { score, maxScore, qualityLevel, gaps, suggestions };
}

/**
 * Run encode task
 *
 * @param {Object} options
 * @param {string} options.input - Decision, insight, or boundary to capture
 * @param {string} [options.context] - Supporting context
 * @param {string} options.repo - Repository root path
 * @param {string} [options.baseline] - Baseline override
 * @returns {Promise<Object>}
 */
export async function runEncode(options) {
  const { input, context, repo: repoRoot, baseline: baselineOverride } = options;

  if (!input || typeof input !== "string" || input.trim().length === 0) {
    const errorResult = {
      status: "ERROR",
      error: "Input is required: provide a decision, insight, or boundary to encode.",
      debug: { tool: "encode", timestamp: new Date().toISOString() },
    };
    writeLast(errorResult);
    return errorResult;
  }

  const fullInput = context ? `${input}\n\nContext: ${context}` : input;

  // Detect encode type
  const encodeType = detectEncodeType(input);

  // Extract structured components
  const title = extractTitle(input);
  const rationale = extractRationale(fullInput);
  const constraints = extractConstraints(fullInput);

  // Assess quality
  const quality = assessQuality(fullInput, encodeType, rationale, constraints);

  // Load index and query canon for encoding-relevant docs
  const baseline = await ensureBaselineRepo(baselineOverride);
  const baselineAvailable = !!baseline.root;

  let index = loadIndex(repoRoot);
  if (!index) {
    index = await buildIndex(repoRoot, baselineAvailable ? baseline.root : null);
    saveIndex(index, repoRoot);
  }

  const { filtered: docs } = applySupersedes(index.documents);

  // Query for decision-encoding relevant canon
  const encodeQuery = `decision encode record ${encodeType} ${input}`;
  const queryTokens = tokenize(encodeQuery);

  const epistemic = {
    mode_ref: "klappy://canon/epistemic#planning",
    confidence: "partial",
  };

  const scored = docs
    .map((doc) => {
      const { score, signals } = scoreDocument(doc, queryTokens, epistemic);
      return { doc, score, signals };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  // Extract canon references
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

    if (canonRefs.length >= 2) break;
  }

  // Build the structured decision artifact
  const artifact = {
    title,
    type: encodeType,
    decision: input.trim(),
    rationale: rationale || "(not provided — add 'because...' to strengthen)",
    constraints,
    status: quality.qualityLevel === "strong" || quality.qualityLevel === "adequate"
      ? "recorded"
      : "draft",
    context: context || null,
    timestamp: new Date().toISOString(),
  };

  const result = {
    status: "ENCODED",
    artifact,
    quality: {
      level: quality.qualityLevel,
      score: quality.score,
      max_score: quality.maxScore,
      gaps: quality.gaps,
      suggestions: quality.suggestions,
    },
    canon_refs: canonRefs,
    debug: {
      tool: "encode",
      reason: "ENCODE_REQUESTED",
      timestamp: new Date().toISOString(),
      repo_root: repoRoot,
      input_preview: input.slice(0, 100),
      encode_type: encodeType,
      quality_level: quality.qualityLevel,
      docs_scored: scored.length,
    },
  };

  writeLast(result);
  return result;
}
