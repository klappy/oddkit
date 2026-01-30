/**
 * oddkit orchestrate - antifragile router for MCP
 *
 * INVARIANT: If message is non-empty, orchestrate MUST return one of:
 *   - catalog (discoverability: "what's in ODD?", "list the canon", etc.)
 *   - librarian (default fallback)
 *   - validate (only on strong completion claim markers)
 *   - explain (only on explicit explain requests)
 *
 * NEVER returns "none" or "NO_ACTION". When uncertain, defaults to librarian.
 * This makes the system helpful even when input is messy.
 */

import { runLibrarian } from "../tasks/librarian.js";
import { runValidate } from "../tasks/validate.js";
import { runCatalog } from "../tasks/catalog.js";
import { runPreflight } from "../tasks/preflight.js";
import { runInstructionSync } from "../tasks/instructionSync.js";
import { explainLast } from "../explain/explain-last.js";
import { readExcerpt } from "../tools/readExcerpt.js";
import { countWords } from "../utils/slicing.js";

/**
 * Action types (no "none" - always route somewhere useful)
 */
export const ACTIONS = {
  ORIENT: "orient",
  PREFLIGHT: "preflight",
  CATALOG: "catalog",
  LIBRARIAN: "librarian",
  VALIDATE: "validate",
  EXPLAIN: "explain",
  INSTRUCTION_SYNC: "instruction_sync",
};

/**
 * Reason codes for action detection
 */
export const REASONS = {
  EXPLICIT_ACTION: "EXPLICIT_ACTION",
  PREFLIGHT_INTENT: "PREFLIGHT_INTENT",
  CATALOG_INTENT: "CATALOG_INTENT",
  EXPLAIN_INTENT: "EXPLAIN_INTENT",
  STRONG_COMPLETION_CLAIM: "STRONG_COMPLETION_CLAIM",
  LOOKUP_QUESTION: "LOOKUP_QUESTION",
  DEFAULT_FALLBACK: "DEFAULT_FALLBACK",
};

/**
 * Validate orchestrate parameters (runtime enforcement)
 * Schema is permissive; this function enforces correctness at runtime.
 */
function validateOrchestrateParams({
  message,
  action,
  baseline_root,
  registry_payload,
  state_payload,
}) {
  if (action === "instruction_sync") {
    const hasBaseline = !!baseline_root;
    const hasPayload = !!registry_payload;

    if (hasBaseline && hasPayload) {
      throw new Error("instruction_sync: cannot provide both baseline_root and registry_payload");
    }
    if (!hasBaseline && !hasPayload) {
      throw new Error("instruction_sync: must provide either baseline_root or registry_payload");
    }
    if (state_payload && !hasPayload) {
      throw new Error(
        "instruction_sync: state_payload requires registry_payload (use baseline_root for filesystem mode)",
      );
    }
    // message optional for instruction_sync
    return;
  }

  // For all other actions (including action omitted)
  if (!message) {
    throw new Error("message is required (unless action is instruction_sync)");
  }

  // Warn if sync params present on non-sync actions
  if (baseline_root || registry_payload || state_payload) {
    console.warn(
      "Warning: baseline_root/registry_payload/state_payload are only used by instruction_sync (ignored)",
    );
  }
}

/**
 * Detect action from user message (antifragile version)
 * Returns { action, reason }
 *
 * IMPORTANT: ORIENT is NOT detected from message content.
 * Per CHARTER.md, ORIENT is action-driven only (caller passes action="orient").
 * oddkit does not interpret phrases like "orient me" - that's upstream's job.
 *
 * Rules (ORDER MATTERS, precision-first):
 *
 * 0. PREFLIGHT - pre-implementation consultation
 *    - Direct: "preflight", "before i implement", "what should i read first", etc.
 *    - Compound: implementation verb + target ("implement catalog", "wire mcp", etc.)
 *
 * 1. CATALOG - discoverability phrases
 *    - "what's in odd", "show me the doctrines", "list the canon", etc.
 *    - "odd map" / "show me the map" only if message contains odd|canon|doctrine
 *
 * 2. EXPLAIN - explicit explain intent
 *    - "explain last", "explain", "why", "what happened"
 *
 * 3. VALIDATE - strong completion claim markers only
 *    - Starts with: done, shipped, implemented, fixed, merged, released, deployed
 *    - Contains PR/commit refs: #123, PR, commit, SHA-like patterns
 *    - Contains explicit completion phrases: "I finished", "I completed", "I deployed"
 *    - NOTE: "done" alone is NOT a validate trigger
 *
 * 4. LIBRARIAN - everything else (DEFAULT)
 *    - questions, statements, vague stuff, angry stuff, "help", anything
 *    - This is the antifragile fallback
 */
export function detectAction(message) {
  if (!message || typeof message !== "string" || message.trim().length === 0) {
    // Even empty message goes to librarian with a helpful response
    return { action: ACTIONS.LIBRARIAN, reason: REASONS.DEFAULT_FALLBACK };
  }

  const m = message.toLowerCase().trim();

  // Rule 0a: PREFLIGHT - pre-implementation consultation
  // Direct triggers
  const preflightPhrases = [
    "preflight",
    "before i implement",
    "before implementing",
    "what should i read first",
    "what constraints apply",
    "what counts as done",
    "any pitfalls",
    "relevant docs",
    "relevant files",
    "pre-implementation",
    "preimplementation",
  ];
  for (const phrase of preflightPhrases) {
    if (m.includes(phrase)) {
      return { action: ACTIONS.PREFLIGHT, reason: REASONS.PREFLIGHT_INTENT };
    }
  }

  // Compound trigger: implementation verb + concrete target
  const implementationVerbs = [
    "implement",
    "wire",
    "refactor",
    "add",
    "change",
    "update",
    "modify",
    "build",
    "create",
  ];
  const concreteTargets = [
    "mcp",
    "server",
    "orchestrate",
    "cli",
    "index",
    "catalog",
    "validate",
    "librarian",
    "preflight",
    "baseline",
    "tools",
  ];
  const hasVerb = implementationVerbs.some((v) => m.includes(v));
  const hasTarget = concreteTargets.some((t) => m.includes(t));
  if (hasVerb && hasTarget) {
    return { action: ACTIONS.PREFLIGHT, reason: REASONS.PREFLIGHT_INTENT };
  }

  // Rule 1: CATALOG - discoverability phrases (conservative)
  const catalogPhrases = [
    "what's in odd",
    "whats in odd",
    "what is in odd",
    "show me the doctrines",
    "doctrines available",
    "doctrines do you have",
    "what should i read",
    "what to read next",
    "what should i read next",
    "list the canon",
    "list canon",
    "top canon",
    "canon list",
  ];
  for (const phrase of catalogPhrases) {
    if (m.includes(phrase)) {
      return { action: ACTIONS.CATALOG, reason: REASONS.CATALOG_INTENT };
    }
  }
  if ((m.includes("odd map") || m.includes("show me the map")) && /odd|canon|doctrine/.test(m)) {
    return { action: ACTIONS.CATALOG, reason: REASONS.CATALOG_INTENT };
  }

  const lower = m;

  // Rule 2: EXPLAIN - explicit explain intent
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

  // Rule 3: VALIDATE - strong completion claim markers ONLY
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

  // Rule 4: LIBRARIAN - everything else (antifragile default)
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
 * Per CHARTER.md: oddkit is epistemic terrain rendering, not reactive search.
 * It adapts behavior based on epistemic context but never infers mode.
 * ORIENT is action-driven only (caller passes action="orient").
 *
 * @param {Object} options
 * @param {string} options.message - The user message
 * @param {string} options.repoRoot - Repository root path
 * @param {string} options.baseline - Baseline override
 * @param {string} [options.action] - Explicit action override (orient, catalog, preflight, librarian, validate, explain, instruction_sync)
 * @param {Object} [options.epistemic] - Optional epistemic context from upstream
 * @param {string} [options.epistemic.mode_ref] - Canon-derived mode URI
 * @param {string} [options.epistemic.confidence] - Caller-declared confidence
 * @param {string} [options.baseline_root] - For instruction_sync: filesystem mode baseline path
 * @param {Object} [options.registry_payload] - For instruction_sync: payload mode registry object
 * @param {Object} [options.state_payload] - For instruction_sync: payload mode state object
 * @returns {Object} { action, assistant_text, result, debug, suggest_orient }
 */
export async function runOrchestrate(options) {
  const {
    message,
    repoRoot,
    baseline,
    action: explicitAction,
    epistemic,
    baseline_root,
    registry_payload,
    state_payload,
  } = options;

  // Runtime validation (schema is permissive, runtime enforces)
  validateOrchestrateParams({
    message,
    action: explicitAction,
    baseline_root,
    registry_payload,
    state_payload,
  });

  // Determine action: explicit action takes precedence, otherwise detect from message
  // Per CHARTER.md: ORIENT is only available via explicit action parameter
  let action, reason;
  if (explicitAction && Object.values(ACTIONS).includes(explicitAction)) {
    action = explicitAction;
    reason = "EXPLICIT_ACTION";
  } else {
    const detected = detectAction(message);
    action = detected.action;
    reason = detected.reason;
  }

  // Check if we should suggest ORIENT based on epistemic context
  // Per CHARTER.md: suggest only, never force or reroute
  let suggestOrient = false;
  if (
    epistemic &&
    epistemic.mode_ref &&
    epistemic.mode_ref.includes("exploration") &&
    epistemic.confidence &&
    epistemic.confidence !== "strong" &&
    epistemic.confidence !== "verified" &&
    action !== ACTIONS.ORIENT
  ) {
    suggestOrient = true;
  }

  // Build base result
  const result = {
    action,
    assistant_text: null,
    result: null,
    suggest_orient: suggestOrient,
    debug: {
      reason,
      message_preview: message ? message.slice(0, 100) : null,
      epistemic_provided: !!epistemic,
      epistemic_mode: epistemic?.mode_ref || null,
      epistemic_confidence: epistemic?.confidence || null,
    },
  };

  // Execute appropriate task
  try {
    switch (action) {
      case ACTIONS.ORIENT: {
        // ORIENT reuses catalog but frames it as terrain/orientation
        const taskResult = await runCatalog({
          repo: repoRoot || process.cwd(),
          baseline,
        });
        result.result = taskResult;
        result.assistant_text = buildOrientAssistantText(taskResult, epistemic);
        break;
      }

      case ACTIONS.PREFLIGHT: {
        const taskResult = await runPreflight({
          repo: repoRoot || process.cwd(),
          baseline,
          message,
        });
        result.result = taskResult;
        result.assistant_text = buildPreflightAssistantText(taskResult);
        break;
      }

      case ACTIONS.CATALOG: {
        const taskResult = await runCatalog({
          repo: repoRoot || process.cwd(),
          baseline,
        });
        result.result = taskResult;
        result.assistant_text = buildCatalogAssistantText(taskResult);
        break;
      }

      case ACTIONS.LIBRARIAN: {
        const taskResult = await runLibrarian({
          query: message || "help",
          repo: repoRoot || process.cwd(),
          baseline,
          epistemic, // Per CHARTER.md: pass epistemic context for retrieval bias
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

      case ACTIONS.INSTRUCTION_SYNC: {
        const syncResult = await runInstructionSync({
          repoRoot: repoRoot || process.cwd(),
          baselineRoot: baseline_root,
          registryPayload: registry_payload,
          statePayload: state_payload,
        });
        return {
          action: "instruction_sync",
          ok: true,
          result: syncResult,
        };
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
 * Build assistant_text for catalog results (menu only; no doc bodies or quotes)
 */
function buildCatalogAssistantText(taskResult) {
  const lines = [];

  lines.push("Start here: " + (taskResult.start_here?.path ?? "(none)"));
  const nextPaths = (taskResult.next_up || []).map((d) => d.path);
  lines.push("Next up: " + (nextPaths.length ? nextPaths.join(", ") : "(none)"));
  lines.push("Top canon by tag:");
  for (const { tag, docs: docList } of taskResult.canon_by_tag || []) {
    if (docList.length > 0) {
      lines.push(`  ${tag}: ${docList.map((d) => d.path).join(", ")}`);
    }
  }
  lines.push("Operational playbooks:");
  for (const p of taskResult.playbooks || []) {
    lines.push(`  ${p.path}`);
  }

  return lines.join("\n").trim();
}

/**
 * Build assistant_text for ORIENT results (terrain rendering)
 * Per CHARTER.md: oddkit is epistemic terrain rendering, not reactive search.
 */
function buildOrientAssistantText(taskResult, epistemic) {
  const lines = [];

  lines.push("Epistemic terrain");
  lines.push("");

  // If epistemic context provided, acknowledge it
  if (epistemic?.mode_ref) {
    const mode = epistemic.mode_ref.split("#").pop() || "unknown";
    const conf = epistemic.confidence || "unspecified";
    lines.push(`Context: ${mode} mode, ${conf} confidence`);
    lines.push("");
  }

  lines.push("Start here: " + (taskResult.start_here?.path ?? "(none)"));
  const nextPaths = (taskResult.next_up || []).map((d) => d.path);
  lines.push("Next up: " + (nextPaths.length ? nextPaths.join(", ") : "(none)"));
  lines.push("");

  lines.push("Canon by tag:");
  for (const { tag, docs: docList } of taskResult.canon_by_tag || []) {
    if (docList.length > 0) {
      lines.push(`  ${tag}: ${docList.map((d) => d.path).join(", ")}`);
    }
  }
  lines.push("");

  lines.push("Operational playbooks:");
  for (const p of taskResult.playbooks || []) {
    lines.push(`  ${p.path}`);
  }
  lines.push("");

  // Contextual suggestions based on epistemic mode (if provided)
  if (epistemic?.mode_ref) {
    lines.push("Suggested next actions:");
    if (epistemic.mode_ref.includes("exploration")) {
      lines.push("  - Read the quickstart or start_here doc");
      lines.push("  - Ask: What constraints apply to [topic]?");
      lines.push("  - Ask: What's the definition of done for [task]?");
    } else if (epistemic.mode_ref.includes("planning")) {
      lines.push("  - Review constraints and governing docs");
      lines.push("  - Ask: What prior decisions affect [topic]?");
      lines.push("  - Run preflight before implementation");
    } else if (epistemic.mode_ref.includes("execution")) {
      lines.push("  - Use librarian for specific policy questions");
      lines.push("  - When ready, validate your completion claim");
    }
  } else {
    lines.push("To go deeper:");
    lines.push("  - Ask a specific policy question (librarian)");
    lines.push("  - Run preflight before implementing");
    lines.push("  - Validate completion claims with artifacts");
  }

  return lines.join("\n").trim();
}

/**
 * Build assistant_text for preflight results (menu + constraints + DoD + pitfalls)
 * Plain text, short, menu-like with progressive disclosure.
 */
function buildPreflightAssistantText(taskResult) {
  const lines = [];

  lines.push("Preflight summary");
  lines.push("");

  // Start here + Next up (reuse catalog format)
  lines.push("Start here: " + (taskResult.start_here?.path ?? "(none)"));
  const nextPaths = (taskResult.next_up || []).map((d) => d.path);
  lines.push("Next up: " + (nextPaths.length ? nextPaths.join(", ") : "(none)"));
  lines.push("");

  // Constraints
  if (taskResult.constraints_docs && taskResult.constraints_docs.length > 0) {
    lines.push("Constraints likely relevant:");
    for (const c of taskResult.constraints_docs) {
      lines.push(`  - ${c.path}`);
    }
    lines.push("");
  }

  // Definition of Done
  if (taskResult.dod) {
    lines.push("Definition of Done: " + taskResult.dod.path);
  } else {
    lines.push("Definition of Done: (not found)");
  }
  lines.push("");

  // Pitfalls
  if (taskResult.pitfalls && taskResult.pitfalls.length > 0) {
    lines.push("Known pitfalls / related operational notes:");
    for (const p of taskResult.pitfalls) {
      const summary = p.title ? ` (${p.title})` : "";
      lines.push(`  - ${p.path}${summary}`);
    }
    lines.push("");
  }

  // Suggested follow-up questions
  if (taskResult.suggested_questions && taskResult.suggested_questions.length > 0) {
    lines.push("If you want more detail, ask one of:");
    for (const q of taskResult.suggested_questions) {
      lines.push(`  - "${q}"`);
    }
  }

  return lines.join("\n").trim();
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
