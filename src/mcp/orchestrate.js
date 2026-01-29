/**
 * oddkit orchestrate - antifragile router for MCP
 *
 * INVARIANT: If message is non-empty, orchestrate MUST return one of:
 *   - librarian (default fallback)
 *   - validate (only on strong completion claim markers)
 *   - explain (only on explicit explain requests)
 *
 * NEVER returns "none" or "NO_ACTION". When uncertain, defaults to librarian.
 * This makes the system helpful even when input is messy.
 */

import { runLibrarian } from "../tasks/librarian.js";
import { runValidate } from "../tasks/validate.js";
import { explainLast } from "../explain/explain-last.js";
import { readExcerpt } from "../tools/readExcerpt.js";
import { countWords } from "../utils/slicing.js";

/**
 * Action types (no "none" - always route somewhere useful)
 */
export const ACTIONS = {
  LIBRARIAN: "librarian",
  VALIDATE: "validate",
  EXPLAIN: "explain",
};

/**
 * Reason codes for action detection
 */
export const REASONS = {
  EXPLAIN_INTENT: "EXPLAIN_INTENT",
  STRONG_COMPLETION_CLAIM: "STRONG_COMPLETION_CLAIM",
  LOOKUP_QUESTION: "LOOKUP_QUESTION",
  DEFAULT_FALLBACK: "DEFAULT_FALLBACK",
};

/**
 * Detect action from user message (antifragile version)
 * Returns { action, reason }
 *
 * Rules (ORDER MATTERS, precision-first):
 *
 * 1. EXPLAIN - highest precision, explicit intent only
 *    - "explain last", "explain", "why", "what happened"
 *
 * 2. VALIDATE - strong completion claim markers only
 *    - Starts with: done, shipped, implemented, fixed, merged, released, deployed
 *    - Contains PR/commit refs: #123, PR, commit, SHA-like patterns
 *    - Contains explicit completion phrases: "I finished", "I completed", "I deployed"
 *    - NOTE: "done" alone is NOT a validate trigger
 *
 * 3. LIBRARIAN - everything else (DEFAULT)
 *    - questions, statements, vague stuff, angry stuff, "help", anything
 *    - This is the antifragile fallback
 */
export function detectAction(message) {
  if (!message || typeof message !== "string" || message.trim().length === 0) {
    // Even empty message goes to librarian with a helpful response
    return { action: ACTIONS.LIBRARIAN, reason: REASONS.DEFAULT_FALLBACK };
  }

  const lower = message.toLowerCase().trim();

  // Rule 1: EXPLAIN - explicit explain intent (highest precision)
  const explainPatterns = [
    /^explain\b/i, // starts with "explain"
    /\bexplain\s*(--)?last\b/i, // "explain last" or "explain --last"
    /\bwhy did (you|it|oddkit)\b/i, // "why did you..."
    /^why\b.*\?$/i, // starts with "why" and ends with ?
    /\bwhat happened\b/i, // "what happened"
  ];

  for (const pattern of explainPatterns) {
    if (pattern.test(message)) {
      return { action: ACTIONS.EXPLAIN, reason: REASONS.EXPLAIN_INTENT };
    }
  }

  // Rule 2: VALIDATE - strong completion claim markers ONLY
  // These are high-precision patterns that indicate actual completion claims
  const validatePatterns = [
    // Starts with completion verb (strong signal)
    /^(done|shipped|implemented|fixed|merged|released|deployed|finished|completed)\s+\w/i,

    // Explicit "I [verb]" completion phrases
    /\bi\s+(finished|completed|deployed|shipped|merged|released|implemented|fixed)\b/i,

    // PR/commit references (strong signal of code completion)
    /\b(pr|pull request)\s*#?\d+/i, // PR #123, pull request 42
    /\bcommit\s+[a-f0-9]{7,}/i, // commit abc1234
    /\b[a-f0-9]{7,40}\b.*\b(merged|pushed|committed)\b/i, // SHA + action
    /\bmerged\s+(to|into)\s+(main|master|develop)\b/i, // merged to main

    // File paths + completion (strong signal)
    /\.(js|ts|py|go|rs|java|rb|md)\b.*\b(done|fixed|updated|implemented)\b/i,
    /\b(done|fixed|updated|implemented)\b.*\.(js|ts|py|go|rs|java|rb|md)\b/i,
  ];

  for (const pattern of validatePatterns) {
    if (pattern.test(message)) {
      return { action: ACTIONS.VALIDATE, reason: REASONS.STRONG_COMPLETION_CLAIM };
    }
  }

  // Rule 3: LIBRARIAN - everything else (antifragile default)
  // Questions get a specific reason, everything else is fallback
  const isQuestion =
    /\?$/.test(message.trim()) ||
    /\b(what|where|how|why|when|which|who|is there|are there|can i|should i)\b/i.test(message);

  if (isQuestion) {
    return { action: ACTIONS.LIBRARIAN, reason: REASONS.LOOKUP_QUESTION };
  }

  // DEFAULT: librarian handles it
  // This includes: statements, vague stuff, angry stuff, "help", "this sucks", anything
  return { action: ACTIONS.LIBRARIAN, reason: REASONS.DEFAULT_FALLBACK };
}

/**
 * Run orchestrate - detect action and execute appropriate task
 *
 * INVARIANT: Always returns { action, assistant_text, result, debug }
 * assistant_text is always populated with something useful to print
 *
 * @param {Object} options
 * @param {string} options.message - The user message
 * @param {string} options.repoRoot - Repository root path
 * @param {string} options.baseline - Baseline override
 * @returns {Object} { action, assistant_text, result, debug }
 */
export async function runOrchestrate(options) {
  const { message, repoRoot, baseline } = options;

  // Detect action (never returns "none")
  const { action, reason } = detectAction(message);

  // Build base result
  const result = {
    action,
    assistant_text: null,
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
          query: message || "help",
          repo: repoRoot || process.cwd(),
          baseline,
        });
        result.result = taskResult;

        // Upgrade quotes if advisory or too short
        if (taskResult.evidence && taskResult.evidence.length > 0) {
          const needsUpgrade =
            taskResult.advisory === true ||
            taskResult.confidence < 0.6 ||
            (taskResult.evidence[0] && (taskResult.evidence[0].wordCount || 0) < 12);

          if (needsUpgrade && taskResult.read_next && taskResult.read_next.length > 0) {
            // Parse primary source citation (format: path#anchor)
            const primarySource = taskResult.read_next[0].path;
            const [path, anchor] = primarySource.includes("#")
              ? primarySource.split("#")
              : [primarySource, null];

            // Determine origin from evidence
            const primaryEvidence = taskResult.evidence.find((e) => e.citation === primarySource);
            const origin = primaryEvidence?.origin || "local";

            // Read excerpt from primary source
            const excerptResult = await readExcerpt({
              repo_root: repoRoot || process.cwd(),
              origin,
              path,
              anchor,
              max_words: 25,
            });

            if (excerptResult && excerptResult.excerpt) {
              // Replace or prepend first evidence with excerpt
              if (taskResult.evidence[0]) {
                taskResult.evidence[0] = {
                  ...taskResult.evidence[0],
                  quote: excerptResult.excerpt,
                  citation: excerptResult.citation,
                  wordCount: countWords(excerptResult.excerpt),
                };
              }

              // Optionally upgrade second evidence if available
              if (
                taskResult.read_next.length > 1 &&
                taskResult.evidence.length > 1 &&
                (taskResult.evidence[1].wordCount || 0) < 12
              ) {
                const secondarySource = taskResult.read_next[1].path;
                const [secPath, secAnchor] = secondarySource.includes("#")
                  ? secondarySource.split("#")
                  : [secondarySource, null];
                const secEvidence = taskResult.evidence.find((e) => e.citation === secondarySource);
                const secOrigin = secEvidence?.origin || "local";

                const secExcerpt = await readExcerpt({
                  repo_root: repoRoot || process.cwd(),
                  origin: secOrigin,
                  path: secPath,
                  anchor: secAnchor,
                  max_words: 25,
                });

                if (secExcerpt && secExcerpt.excerpt) {
                  taskResult.evidence[1] = {
                    ...taskResult.evidence[1],
                    quote: secExcerpt.excerpt,
                    citation: secExcerpt.citation,
                    wordCount: countWords(secExcerpt.excerpt),
                  };
                }
              }
            }
          }
        }

        // Build assistant_text for Cursor to print verbatim
        result.assistant_text = buildLibrarianAssistantText(taskResult, reason);
        break;
      }

      case ACTIONS.VALIDATE: {
        const taskResult = await runValidate({
          message,
          repo: repoRoot || process.cwd(),
          baseline,
        });
        result.result = taskResult;
        result.assistant_text = buildValidateAssistantText(taskResult);
        break;
      }

      case ACTIONS.EXPLAIN: {
        const taskResult = explainLast({ format: "json" });
        result.result = taskResult;
        result.assistant_text = buildExplainAssistantText(taskResult);
        break;
      }
    }
  } catch (err) {
    result.result = {
      error: err.message || "Task execution failed",
    };
    result.debug.error = err.message;
    result.assistant_text = `Error: ${err.message || "Task execution failed"}`;
  }

  return result;
}

/**
 * Build assistant_text for librarian results
 */
function buildLibrarianAssistantText(taskResult, reason) {
  let assistantText = "";

  // Add advisory message if needed
  if (taskResult.advisory) {
    assistantText += `Advisory: confidence ${taskResult.confidence} because `;
    if (taskResult.confidence < 0.6) {
      assistantText += "evidence quality is low";
    } else if (taskResult.arbitration?.warnings?.some((w) => w.type === "URI_COLLISION")) {
      assistantText += "identity collision detected";
    } else {
      assistantText += "uncertainty in results";
    }
    assistantText += ".\n\n";
  }

  // If this was a fallback (vague input), add a helpful note
  if (reason === REASONS.DEFAULT_FALLBACK && taskResult.evidence?.length > 0) {
    assistantText += "Here's what I found that might be relevant:\n\n";
  }

  // Add answer
  assistantText += (taskResult.answer || "No specific answer found.") + "\n\n";

  // Add evidence quotes with citations
  if (taskResult.evidence && taskResult.evidence.length > 0) {
    for (const ev of taskResult.evidence.slice(0, 4)) {
      // Strip leading ">" if quote already has it (from extractQuote)
      const cleanQuote = ev.quote.startsWith("> ") ? ev.quote.slice(2) : ev.quote;
      assistantText += `> ${cleanQuote}\n\n`;
      assistantText += `— ${ev.citation}\n\n`;
    }
  }

  // If low evidence and fallback, suggest a follow-up question
  if (
    reason === REASONS.DEFAULT_FALLBACK &&
    (!taskResult.evidence || taskResult.evidence.length < 2)
  ) {
    assistantText += "Could you clarify what you're looking for? ";
    assistantText += "For example: What rule or policy applies? What are you trying to verify?\n";
  }

  return assistantText.trim();
}

/**
 * Build assistant_text for validate results
 */
function buildValidateAssistantText(taskResult) {
  let assistantText = "";

  if (taskResult.verdict === "VERIFIED") {
    assistantText += `Verified: Your completion claim checks out.\n\n`;
  } else if (taskResult.verdict === "NEEDS_ARTIFACTS") {
    assistantText += `Needs artifacts: Your claim requires additional evidence.\n\n`;
  } else {
    assistantText += `Validation result: ${taskResult.verdict || "unknown"}\n\n`;
  }

  if (taskResult.claims && taskResult.claims.length > 0) {
    assistantText += `Claims detected:\n`;
    for (const claim of taskResult.claims) {
      assistantText += `- ${claim}\n`;
    }
    assistantText += "\n";
  }

  if (taskResult.gaps && taskResult.gaps.length > 0) {
    assistantText += `Missing evidence:\n`;
    for (const gap of taskResult.gaps) {
      assistantText += `- ${gap}\n`;
    }
    assistantText += "\n";
  }

  if (taskResult.matched_evidence && taskResult.matched_evidence.length > 0) {
    assistantText += `Evidence found: ${taskResult.matched_evidence.join(", ")}\n`;
  }

  return assistantText.trim();
}

/**
 * Build assistant_text for explain results
 */
function buildExplainAssistantText(taskResult) {
  if (!taskResult || taskResult.error) {
    return taskResult?.error || "No previous run to explain. Try running a query first.";
  }

  let assistantText = "";

  if (taskResult.tool) {
    assistantText += `Last run: ${taskResult.tool}\n`;
  }

  if (taskResult.verdict) {
    assistantText += `Verdict: ${taskResult.verdict}\n`;
  }

  if (taskResult.status) {
    assistantText += `Status: ${taskResult.status}\n`;
  }

  if (taskResult.confidence !== undefined) {
    assistantText += `Confidence: ${taskResult.confidence}\n`;
  }

  if (taskResult.reasons && taskResult.reasons.length > 0) {
    assistantText += `\nWhy this happened:\n`;
    for (const r of taskResult.reasons) {
      assistantText += `- ${r}\n`;
    }
  }

  if (taskResult.next_steps && taskResult.next_steps.length > 0) {
    assistantText += `\nNext steps:\n`;
    for (const step of taskResult.next_steps) {
      assistantText += `- ${step}\n`;
    }
  }

  return assistantText.trim() || "Explained last run. Check result for details.";
}
