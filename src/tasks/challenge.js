/**
 * Challenge task — pressure-test a claim, assumption, or proposal.
 *
 * Queries canon for relevant constraints and surfaces tensions,
 * missing evidence, unexamined risks, and contradictions.
 * Applies challenge proportionally per canon epistemic-challenge constraints.
 *
 * Does NOT carry embedded knowledge — queries canon at runtime.
 */

import { buildIndex, loadIndex, saveIndex, INDEX_VERSION } from "../index/buildIndex.js";
import { ensureBaselineRepo } from "../baseline/ensureBaselineRepo.js";
import { applySupersedes } from "../resolve/applySupersedes.js";
import { tokenize, scoreDocument, findBestHeading } from "../utils/scoring.js";
import { extractQuote, formatCitation, countWords } from "../utils/slicing.js";
import { writeLast } from "../state/last.js";

/**
 * Detect claim type from input for proportional challenge.
 * Returns: "strong_claim" | "assumption" | "proposal" | "observation"
 */
function detectClaimType(input) {
  const lower = input.toLowerCase();

  // Strong claims: definitive statements
  if (
    /\b(must|always|never|guaranteed|impossible|certain|definitely|obviously|clearly)\b/i.test(
      input,
    )
  ) {
    return "strong_claim";
  }

  // Proposals: future-oriented plans
  if (/\b(should|plan to|going to|will|propose|suggest|recommend|let's|want to)\b/i.test(input)) {
    return "proposal";
  }

  // Assumptions: implicit premises
  if (/\b(assume|assuming|presume|given that|since|because|if we)\b/i.test(input)) {
    return "assumption";
  }

  return "observation";
}

/**
 * Generate challenge questions proportional to claim strength.
 * Stronger claims get harder challenges.
 */
function generateChallenges(claimType, input, tensions) {
  const challenges = [];

  switch (claimType) {
    case "strong_claim":
      challenges.push("What evidence would disprove this?");
      challenges.push("Under what conditions does this NOT hold?");
      challenges.push("Who or what would disagree with this, and why?");
      break;

    case "proposal":
      challenges.push("What's the cost of being wrong here?");
      challenges.push("What alternatives were considered and rejected?");
      challenges.push("What would need to be true for this to fail?");
      break;

    case "assumption":
      challenges.push("Has this assumption been validated with evidence?");
      challenges.push("What if this assumption is wrong — what breaks?");
      challenges.push("Is this assumption documented or just implicit?");
      break;

    case "observation":
      challenges.push("Is this observation based on a representative sample?");
      challenges.push("What context might change this observation?");
      break;
  }

  // Add tension-specific challenges
  for (const tension of tensions.slice(0, 2)) {
    challenges.push(`Canon tension: ${tension.message}`);
  }

  return challenges;
}

/**
 * Find tensions between input and canon constraints.
 * A tension is where the input may conflict with documented constraints.
 */
function findTensions(input, canonDocs) {
  const tensions = [];
  const inputLower = input.toLowerCase();

  for (const { doc, quote, citation } of canonDocs) {
    if (!quote) continue;
    const quoteLower = quote.toLowerCase();

    // Check for normative language in canon that might contradict input
    const normativePatterns = [
      { pattern: /\bMUST NOT\b/, type: "prohibition" },
      { pattern: /\bMUST\b/, type: "requirement" },
      { pattern: /\bSHOULD NOT\b/, type: "discouragement" },
      { pattern: /\bSHOULD\b/, type: "recommendation" },
      { pattern: /\bNEVER\b/, type: "prohibition" },
      { pattern: /\bALWAYS\b/, type: "requirement" },
    ];

    for (const { pattern, type } of normativePatterns) {
      if (pattern.test(quote)) {
        tensions.push({
          type,
          citation,
          quote: quote.slice(0, 80),
          message: `Canon ${type} found in ${citation} — verify your input doesn't conflict`,
        });
        break; // One tension per doc
      }
    }
  }

  return tensions;
}

/**
 * Identify missing prerequisites — what evidence or decisions are absent.
 */
function findMissingPrerequisites(claimType, input, canonRefs) {
  const missing = [];

  // Universal prerequisites
  if (!/\bevidence\b/i.test(input) && !/\bdata\b/i.test(input)) {
    missing.push("No evidence cited — claims without evidence are assumptions");
  }

  if (claimType === "proposal" || claimType === "strong_claim") {
    if (!/\balternative/i.test(input) && !/\binstead\b/i.test(input)) {
      missing.push("No alternatives mentioned — single-option proposals lack rigor");
    }
    if (!/\brisk/i.test(input) && !/\bcost\b/i.test(input) && !/\bdownside\b/i.test(input)) {
      missing.push("No risks or costs acknowledged");
    }
  }

  if (claimType === "assumption") {
    if (!/\btest/i.test(input) && !/\bverif/i.test(input) && !/\bvalidat/i.test(input)) {
      missing.push("Assumption not marked for validation");
    }
  }

  return missing;
}

/**
 * Run challenge task
 *
 * @param {Object} options
 * @param {string} options.input - Claim, assumption, or proposal to challenge
 * @param {string} [options.mode] - Epistemic mode context (exploration/planning/execution)
 * @param {string} options.repo - Repository root path
 * @param {string} [options.baseline] - Baseline override
 * @returns {Promise<Object>}
 */
export async function runChallenge(options) {
  const { input, mode: modeContext, repo: repoRoot, baseline: baselineOverride } = options;

  if (!input || typeof input !== "string" || input.trim().length === 0) {
    const errorResult = {
      status: "ERROR",
      error: "Input is required: provide a claim, assumption, or proposal to challenge.",
      debug: { tool: "challenge", timestamp: new Date().toISOString() },
    };
    writeLast(errorResult);
    return errorResult;
  }

  const claimType = detectClaimType(input);

  // Load index and query canon
  const baseline = await ensureBaselineRepo(baselineOverride);
  const baselineAvailable = !!baseline.root;

  let index = loadIndex(repoRoot);
  // Schema version gate: stale index shapes (e.g. missing start_here fields) silently
  // break newer features. A version mismatch forces a full rebuild.
  if (index && index.version !== INDEX_VERSION) {
    index = null;
  }
  if (!index) {
    index = await buildIndex(repoRoot, baselineAvailable ? baseline.root : null);
    saveIndex(index, repoRoot);
  }

  const { filtered: docs } = applySupersedes(index.documents);

  // Build query that emphasizes constraints and challenge-relevant docs
  const challengeQuery = `constraints challenges risks ${input}`;
  const queryTokens = tokenize(challengeQuery);

  // Use planning mode bias to boost governing/constraint docs
  const epistemic = modeContext
    ? {
        mode_ref: `klappy://canon/epistemic#${modeContext}`,
        confidence: "partial",
      }
    : {
        mode_ref: "klappy://canon/epistemic#planning",
        confidence: "low",
      };

  const scored = docs
    .map((doc) => {
      const { score, signals } = scoreDocument(doc, queryTokens, epistemic);
      return { doc, score, signals };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  // Extract canon references with quotes
  const canonDocs = [];
  for (const { doc } of scored) {
    const heading = findBestHeading(doc, queryTokens);
    if (!heading) continue;

    const quoteResult = extractQuote(doc, heading);
    if (!quoteResult || quoteResult.wordCount < 8) continue;

    const citation = formatCitation(doc, heading);
    canonDocs.push({
      doc,
      quote: quoteResult.quote,
      citation,
      origin: doc.origin,
    });

    if (canonDocs.length >= 4) break;
  }

  // Find tensions between input and canon
  const tensions = findTensions(input, canonDocs);

  // Find missing prerequisites
  const missingPrereqs = findMissingPrerequisites(claimType, input, canonDocs);

  // Generate proportional challenges
  const challenges = generateChallenges(claimType, input, tensions);

  // Build suggested reframings
  const reframings = [];
  if (claimType === "strong_claim") {
    reframings.push("Reframe as hypothesis: 'We believe X because Y, and would reconsider if Z'");
  }
  if (claimType === "assumption") {
    reframings.push("Make explicit: state the assumption and how you'd validate it");
  }
  if (claimType === "proposal") {
    reframings.push("Add optionality: 'We're choosing X over Y because Z, reversible until W'");
  }
  if (tensions.length > 0) {
    reframings.push("Address canon tensions directly before proceeding");
  }

  const result = {
    status: "CHALLENGED",
    claim_type: claimType,
    tensions,
    missing_prerequisites: missingPrereqs,
    challenges,
    suggested_reframings: reframings,
    canon_constraints: canonDocs.map((c) => ({
      citation: c.citation,
      quote: c.quote,
      origin: c.origin,
    })),
    debug: {
      tool: "challenge",
      reason: "CHALLENGE_REQUESTED",
      timestamp: new Date().toISOString(),
      repo_root: repoRoot,
      input_preview: input.slice(0, 100),
      claim_type: claimType,
      mode_context: modeContext || null,
      docs_scored: scored.length,
      tensions_found: tensions.length,
    },
  };

  writeLast(result);
  return result;
}
