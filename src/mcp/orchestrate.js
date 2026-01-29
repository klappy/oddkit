/**
 * oddkit orchestrate - thin router for MCP
 *
 * Routes user messages to the appropriate task:
 *   - librarian: for policy/lookup questions
 *   - validate: for completion claims
 *   - explain: for explain requests
 *   - none: when intent is unclear
 *
 * This is intentionally simple - no fancy intent classification.
 */

import { runLibrarian } from "../tasks/librarian.js";
import { runValidate } from "../tasks/validate.js";
import { explainLast } from "../explain/explain-last.js";

/**
 * Action types
 */
export const ACTIONS = {
  LIBRARIAN: "librarian",
  VALIDATE: "validate",
  EXPLAIN: "explain",
  NONE: "none",
};

/**
 * Reason codes for action detection
 */
export const REASONS = {
  EXPLAIN_INTENT: "EXPLAIN_INTENT",
  COMPLETION_CLAIM: "COMPLETION_CLAIM",
  LOOKUP_QUESTION: "LOOKUP_QUESTION",
  NO_MATCH: "NO_MATCH",
};

/**
 * Detect action from user message
 * Returns { action, reason }
 *
 * Rules (simple heuristics, ORDER MATTERS):
 * 1. Explain intent: "explain --last", starts with "explain", "why did you" + "last"
 * 2. Lookup question FIRST: contains question keywords (what is, where is, definition of, etc.)
 *    - This prevents "definition of done" from matching "done" as completion claim
 * 3. Completion claim: contains completion keywords (done, fixed, implemented, etc.)
 * 4. Fallback: none
 */
export function detectAction(message) {
  if (!message || typeof message !== "string") {
    return { action: ACTIONS.NONE, reason: REASONS.NO_MATCH };
  }

  const lower = message.toLowerCase().trim();

  // Rule 1: Explain intent
  if (
    lower.includes("explain --last") ||
    lower.includes("explain last") ||
    lower.startsWith("explain") ||
    (lower.includes("why did you") && lower.includes("last"))
  ) {
    return { action: ACTIONS.EXPLAIN, reason: REASONS.EXPLAIN_INTENT };
  }

  // Rule 2: Lookup/policy question FIRST
  // Check this before completion claims to avoid "definition of done" matching "done"
  const lookupPatterns = [
    /\b(what is|what are|where is|where are|what does|how do|how does)\b/i,
    /\b(definition of|rule about|policy for|policy on|canon says|odd says)\b/i,
    /\b(constraint|requirement)\b/i,
    /\?$/, // Ends with question mark
  ];

  for (const pattern of lookupPatterns) {
    if (pattern.test(message)) {
      return { action: ACTIONS.LIBRARIAN, reason: REASONS.LOOKUP_QUESTION };
    }
  }

  // Rule 3: Completion claim (validation)
  // Only check after lookup patterns to avoid false positives
  const completionPatterns = [
    /^done with\b/i,
    /\bi (did|have|finished|completed|shipped|implemented|fixed)\b/i,
    /\bpr\s*(is\s*)?(ready|merged|submitted)\b/i,
    /\b(done|fixed|implemented|shipped|complete|completed|finished)\b.*\./i, // Completion word followed by period
    /^(done|fixed|implemented|shipped|complete|completed|finished)\b/i, // Starts with completion word
  ];

  for (const pattern of completionPatterns) {
    if (pattern.test(message)) {
      return { action: ACTIONS.VALIDATE, reason: REASONS.COMPLETION_CLAIM };
    }
  }

  // Rule 4: Fallback - no match
  return { action: ACTIONS.NONE, reason: REASONS.NO_MATCH };
}

/**
 * Run orchestrate - detect action and execute appropriate task
 *
 * @param {Object} options
 * @param {string} options.message - The user message
 * @param {string} options.repoRoot - Repository root path
 * @param {string} options.baseline - Baseline override
 * @returns {Object} { action, result, debug }
 */
export async function runOrchestrate(options) {
  const { message, repoRoot, baseline } = options;

  // Detect action
  const { action, reason } = detectAction(message);

  // Build base result
  const result = {
    action,
    result: null,
    debug: {
      reason,
      message_preview: message ? message.slice(0, 100) : null,
    },
  };

  // Execute appropriate task
  try {
    switch (action) {
      case ACTIONS.LIBRARIAN: {
        const taskResult = await runLibrarian({
          query: message,
          repo: repoRoot || process.cwd(),
          baseline,
        });
        result.result = taskResult;
        break;
      }

      case ACTIONS.VALIDATE: {
        const taskResult = await runValidate({
          message,
          repo: repoRoot || process.cwd(),
          baseline,
        });
        result.result = taskResult;
        break;
      }

      case ACTIONS.EXPLAIN: {
        const taskResult = explainLast({ format: "json" });
        result.result = taskResult;
        break;
      }

      case ACTIONS.NONE:
      default: {
        result.result = {
          status: "NO_ACTION",
          message: "Could not determine appropriate action from message",
          hint: "Try phrasing as a question or completion claim",
        };
        break;
      }
    }
  } catch (err) {
    result.result = {
      error: err.message || "Task execution failed",
    };
    result.debug.error = err.message;
  }

  return result;
}
