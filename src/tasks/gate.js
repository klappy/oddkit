/**
 * Gate task — check transition prerequisites before mode changes.
 *
 * Validates that a proposed transition (e.g., "ready to build") has
 * met its prerequisites. Surfaces unmet requirements and missing evidence.
 * Applies boundary-transitions-require-deceleration and
 * irreversibility-is-the-real-cost principles from canon.
 *
 * Does NOT carry embedded knowledge — queries canon at runtime.
 */

import { buildIndex, loadIndex, saveIndex } from "../index/buildIndex.js";
import { ensureBaselineRepo } from "../baseline/ensureBaselineRepo.js";
import { applySupersedes } from "../resolve/applySupersedes.js";
import { tokenize, scoreDocument, findBestHeading } from "../utils/scoring.js";
import { extractQuote, formatCitation } from "../utils/slicing.js";
import { writeLast } from "../state/last.js";

/**
 * Detect what transition is being proposed.
 * Returns { from, to } where each is an epistemic mode.
 */
function detectTransition(input) {
  const lower = input.toLowerCase();

  // Explicit transitions
  if (/\b(ready to build|ready to implement|start building|let's code|start coding)\b/i.test(input)) {
    return { from: "planning", to: "execution" };
  }
  if (/\b(ready to plan|start planning|let's plan|time to plan|move to planning)\b/i.test(input)) {
    return { from: "exploration", to: "planning" };
  }
  if (/\b(moving to planning)\b/i.test(input)) {
    return { from: "exploration", to: "planning" };
  }
  if (/\b(moving to execution|moving to build)\b/i.test(input)) {
    return { from: "planning", to: "execution" };
  }
  if (/\b(back to exploration|need to rethink|step back|reconsider)\b/i.test(input)) {
    return { from: "execution", to: "exploration" };
  }
  if (/\b(ship|deploy|release|go live|push to prod)\b/i.test(input)) {
    return { from: "execution", to: "completion" };
  }

  // Default: assume moving forward from exploration
  if (/\b(ready|let's go|proceed|move forward|next step)\b/i.test(input)) {
    return { from: "exploration", to: "planning" };
  }

  return { from: "unknown", to: "unknown" };
}

/**
 * Define prerequisite checks for each transition type.
 * Returns array of { check, description, required }.
 */
function getTransitionPrerequisites(from, to) {
  const prereqs = [];

  if (from === "exploration" && to === "planning") {
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
    prereqs.push({
      id: "assumptions_explicit",
      description: "Key assumptions are stated explicitly",
      required: false,
    });
  }

  if (from === "planning" && to === "execution") {
    prereqs.push({
      id: "decisions_locked",
      description: "Key decisions are locked (not still open)",
      required: true,
    });
    prereqs.push({
      id: "dod_defined",
      description: "Definition of done is clear",
      required: true,
    });
    prereqs.push({
      id: "irreversibility_assessed",
      description: "Irreversible aspects have been identified and accepted",
      required: true,
    });
    prereqs.push({
      id: "constraints_satisfied",
      description: "All MUST constraints are addressable",
      required: true,
    });
    prereqs.push({
      id: "alternatives_considered",
      description: "Alternatives were evaluated before converging",
      required: false,
    });
  }

  if (to === "completion") {
    prereqs.push({
      id: "dod_met",
      description: "Definition of done criteria are met with evidence",
      required: true,
    });
    prereqs.push({
      id: "artifacts_present",
      description: "Required artifacts (tests, screenshots, etc.) are present",
      required: true,
    });
    prereqs.push({
      id: "constraints_verified",
      description: "Constraints have been verified, not just assumed",
      required: true,
    });
  }

  // Reverse transitions (deceleration)
  if (
    (from === "execution" && to === "exploration") ||
    (from === "planning" && to === "exploration")
  ) {
    prereqs.push({
      id: "reason_documented",
      description: "Reason for stepping back is documented",
      required: true,
    });
    prereqs.push({
      id: "work_preserved",
      description: "Existing work is preserved (not discarded)",
      required: false,
    });
  }

  return prereqs;
}

/**
 * Evaluate prerequisites against the context provided.
 * Returns { met: [], unmet: [], unknown: [] }
 */
function evaluatePrerequisites(prereqs, input, canonRefs) {
  const met = [];
  const unmet = [];
  const unknown = [];

  const inputLower = input.toLowerCase();

  for (const prereq of prereqs) {
    // Try to detect if the prerequisite is addressed in the input
    let isMet = false;

    switch (prereq.id) {
      case "problem_defined":
        isMet = inputLower.length > 50 && /\b(problem|goal|objective|need|issue)\b/i.test(input);
        break;
      case "constraints_reviewed":
        isMet = /\b(constraint|rule|policy|reviewed|checked)\b/i.test(input);
        break;
      case "assumptions_explicit":
        isMet = /\b(assum|presum|given that)\b/i.test(input);
        break;
      case "decisions_locked":
        isMet = /\b(decided|locked|chosen|selected|committed)\b/i.test(input);
        break;
      case "dod_defined":
        isMet = /\b(definition of done|dod|done when|complete when|acceptance criteria)\b/i.test(input);
        break;
      case "irreversibility_assessed":
        isMet = /\b(irreversib|can't undo|one-way|point of no return)\b/i.test(input);
        break;
      case "constraints_satisfied":
        isMet = /\b(constraints? (met|satisfied|addressed|handled))\b/i.test(input);
        break;
      case "dod_met":
        isMet = /\b(done|complete|finished|all criteria)\b/i.test(input);
        break;
      case "artifacts_present":
        isMet = /\b(screenshot|test|log|artifact|evidence|proof)\b/i.test(input);
        break;
      case "constraints_verified":
        isMet = /\b(verified|confirmed|validated|checked against)\b/i.test(input);
        break;
      case "reason_documented":
        isMet = /\b(because|reason|due to|since|found that)\b/i.test(input);
        break;
      case "alternatives_considered":
        isMet = /\b(alternative|option|instead|compared|versus|vs)\b/i.test(input);
        break;
      case "work_preserved":
        isMet = /\b(saved|preserved|backed up|branch|stash)\b/i.test(input);
        break;
      default:
        unknown.push(prereq);
        continue;
    }

    if (isMet) {
      met.push(prereq);
    } else if (prereq.required) {
      unmet.push(prereq);
    } else {
      unknown.push(prereq);
    }
  }

  return { met, unmet, unknown };
}

/**
 * Run gate task
 *
 * @param {Object} options
 * @param {string} options.input - Proposed transition description
 * @param {string} [options.context] - Additional context about what's been decided
 * @param {string} options.repo - Repository root path
 * @param {string} [options.baseline] - Baseline override
 * @returns {Promise<Object>}
 */
export async function runGate(options) {
  const { input, context, repo: repoRoot, baseline: baselineOverride } = options;

  if (!input || typeof input !== "string" || input.trim().length === 0) {
    const errorResult = {
      status: "ERROR",
      error: "Input is required: describe the transition you're proposing.",
      debug: { tool: "gate", timestamp: new Date().toISOString() },
    };
    writeLast(errorResult);
    return errorResult;
  }

  // Combine input with context for richer evaluation
  const fullInput = context ? `${input}\n\nContext: ${context}` : input;

  // Detect the proposed transition
  const transition = detectTransition(input);

  // Get prerequisites for this transition type
  const prereqs = getTransitionPrerequisites(transition.from, transition.to);

  // Evaluate prerequisites against provided context
  const evaluation = evaluatePrerequisites(prereqs, fullInput, []);

  // Load index and query canon for transition-relevant docs
  const baseline = await ensureBaselineRepo(baselineOverride);
  const baselineAvailable = !!baseline.root;

  let index = loadIndex(repoRoot);
  if (!index) {
    index = await buildIndex(repoRoot, baselineAvailable ? baseline.root : null);
    saveIndex(index, repoRoot);
  }

  const { filtered: docs } = applySupersedes(index.documents);

  // Query for transition-relevant canon
  const gateQuery = `transition boundary deceleration irreversibility ${input}`;
  const queryTokens = tokenize(gateQuery);

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
    .slice(0, 5);

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

    if (canonRefs.length >= 3) break;
  }

  // Determine gate status
  const hasRequiredUnmet = evaluation.unmet.length > 0;
  const gateStatus = hasRequiredUnmet ? "NOT_READY" : "PASS";

  // Build missing evidence list
  const missingEvidence = evaluation.unmet.map((p) => p.description);
  if (evaluation.unknown.length > 0) {
    for (const u of evaluation.unknown) {
      missingEvidence.push(`${u.description} (not confirmed — provide evidence)`);
    }
  }

  const result = {
    status: gateStatus,
    transition: {
      from: transition.from,
      to: transition.to,
    },
    prerequisites: {
      met: evaluation.met.map((p) => p.description),
      unmet: evaluation.unmet.map((p) => p.description),
      unknown: evaluation.unknown.map((p) => p.description),
      total: prereqs.length,
      required_met: evaluation.met.filter((p) => p.required).length,
      required_total: prereqs.filter((p) => p.required).length,
    },
    missing_evidence: missingEvidence,
    canon_refs: canonRefs,
    debug: {
      tool: "gate",
      reason: "GATE_REQUESTED",
      timestamp: new Date().toISOString(),
      repo_root: repoRoot,
      input_preview: input.slice(0, 100),
      transition_detected: transition,
      prereqs_count: prereqs.length,
      docs_scored: scored.length,
    },
  };

  writeLast(result);
  return result;
}
