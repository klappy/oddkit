/**
 * ODD Orchestrator - Unified Guide + Scribe for agentic work.
 *
 * Combines epistemic mode tracking, posture enforcement, and
 * learning/decision capture into a single orchestration layer
 * that wraps the base oddkit orchestrate functionality.
 */

import { runOrchestrate as runBaseOrchestrate, detectAction, ACTIONS } from "../mcp/orchestrate.js";
import { loadOrchestratorState, saveOrchestratorState, resetOrchestratorState } from "./state.js";
import { getModeConfig, getModeUri } from "./mode.js";
import {
  applyPosture,
  gateAction,
  refusePrematureExecution,
  discoveryPushback,
  detectTransitionIntent,
} from "./guide.js";
import { detectSmells, proposeCapture, writeLedgerEntry } from "./scribe.js";
import { canTransition, executeTransition, getAvailableTransitions } from "./transitions.js";

/**
 * Run the unified ODD Orchestrator.
 *
 * Combines Guide + Scribe roles with mode-aware posture.
 *
 * @param {Object} options
 * @param {string} options.message - The user message
 * @param {string} options.repoRoot - Repository root path
 * @param {string} [options.baseline] - Baseline override
 * @param {string} [options.action] - Explicit action override
 * @param {string} [options.mode] - Explicit mode override (discovery/planning/execution)
 * @param {string} [options.transition_to] - Request mode transition
 * @param {boolean} [options.capture_consent] - Consent to capture pending learnings/decisions
 * @param {Object} [options.capture_entry] - Specific entry to capture (with consent)
 * @param {boolean} [options.reset_session] - Reset orchestrator state to fresh
 * @returns {Object} Orchestrator result with action, result, mode, posture, pushbacks, capture_proposals
 */
export async function runOrchestrator(options) {
  const {
    message,
    repoRoot,
    baseline,
    action: explicitAction,
    mode: explicitMode,
    transition_to,
    capture_consent,
    capture_entry,
    reset_session,
  } = options;

  // Handle session reset
  if (reset_session) {
    const freshState = resetOrchestratorState();
    return {
      action: "session_reset",
      success: true,
      current_mode: freshState.mode.current_mode,
      posture: applyPosture(freshState.mode.current_mode, freshState.mode).posture,
      assistant_text: "Session reset. Starting fresh in discovery mode.",
    };
  }

  // Load session state
  let state = loadOrchestratorState();

  // Handle explicit mode override
  if (explicitMode && getModeConfig(explicitMode)) {
    state.mode.current_mode = explicitMode;
  }

  const currentMode = state.mode.current_mode;
  const postureInfo = applyPosture(currentMode, state.mode);

  // Handle capture consent (write pending entry to ledger)
  if (capture_consent && capture_entry) {
    try {
      const writeResult = writeLedgerEntry(
        capture_entry.entry,
        capture_entry.ledger,
        repoRoot || process.cwd(),
      );
      state.pending_captures = state.pending_captures.filter(
        (p) => p.entry.id !== capture_entry.entry.id,
      );
      saveOrchestratorState(state);
      return {
        action: "capture_complete",
        success: true,
        current_mode: currentMode,
        posture: postureInfo.posture,
        captured: {
          ledger: capture_entry.ledger,
          entry_id: capture_entry.entry.id,
          path: writeResult.path,
        },
        assistant_text: `Captured ${capture_entry.ledger} entry: ${capture_entry.entry.id}`,
      };
    } catch (err) {
      return {
        action: "capture_failed",
        success: false,
        error: err.message,
        current_mode: currentMode,
        posture: postureInfo.posture,
        assistant_text: `Failed to capture: ${err.message}`,
      };
    }
  }

  // Handle mode transition request
  if (transition_to) {
    const transitionResult = executeTransition(currentMode, transition_to, state.mode, message);
    if (!transitionResult.success) {
      return {
        action: "transition_blocked",
        success: false,
        error: transitionResult.error,
        missing: transitionResult.missing,
        current_mode: currentMode,
        posture: postureInfo.posture,
        assistant_text: buildTransitionBlockedText(transitionResult, currentMode, transition_to),
      };
    }
    state.mode = transitionResult.state;
    saveOrchestratorState(state);

    // Update posture for new mode
    const newPosture = applyPosture(transition_to, state.mode);
    return {
      action: "transition_complete",
      success: true,
      from_mode: currentMode,
      current_mode: transition_to,
      posture: newPosture.posture,
      assistant_text: buildTransitionCompleteText(currentMode, transition_to, newPosture),
    };
  }

  // Detect action from message
  const actionToRun = explicitAction || detectActionFromMessage(message);

  // Gate the action against current mode
  const gate = gateAction(actionToRun, currentMode, state.mode);
  if (!gate.allowed) {
    return {
      action: "action_blocked",
      success: false,
      blocked_action: actionToRun,
      error: gate.reason,
      suggestion: gate.suggestion,
      current_mode: currentMode,
      posture: postureInfo.posture,
      transition_available: getAvailableTransitions(currentMode, state.mode),
      assistant_text: buildActionBlockedText(gate, currentMode, actionToRun),
    };
  }

  // Check for premature execution attempt
  if (currentMode === "planning" && actionToRun === "validate") {
    const refusal = refusePrematureExecution(state.mode);
    if (refusal.refused) {
      return {
        action: "execution_refused",
        success: false,
        error: refusal.message,
        missing: refusal.missing,
        current_mode: currentMode,
        posture: postureInfo.posture,
        assistant_text: refusal.message,
      };
    }
  }

  // Apply discovery pushback if in discovery mode
  let pushbacks = [];
  if (currentMode === "discovery" && message) {
    pushbacks = discoveryPushback(message, state.mode);
  }

  // Detect transition intent (advisory only)
  let transitionHint = null;
  if (message) {
    const intent = detectTransitionIntent(message);
    if (intent.detected && intent.to_mode !== currentMode) {
      const check = canTransition(currentMode, intent.to_mode, state.mode);
      transitionHint = {
        detected_intent: intent.to_mode,
        confidence: intent.confidence,
        available: check.valid,
        missing: check.missing,
      };
    }
  }

  // Run the base orchestrate action
  const baseResult = await runBaseOrchestrate({
    message,
    repoRoot,
    baseline,
    action: actionToRun,
    epistemic: {
      mode_ref: getModeUri(currentMode),
      confidence: getConfidenceFromState(state.mode),
    },
  });

  // Smell detection (Scribe role)
  let smells = [];
  let captureProposals = [];
  if (message) {
    smells = detectSmells(message, {
      sources: baseResult.result?.sources || [],
      conversation_context: message,
    });

    if (smells.length > 0) {
      captureProposals = proposeCapture(smells, repoRoot || process.cwd());
    }
  }

  // Update state
  state.last_action = actionToRun;
  if (captureProposals.length > 0) {
    state.pending_captures = [...state.pending_captures, ...captureProposals];
  }

  // Track validation for execution mode transitions
  if (actionToRun === "validate" && baseResult.result?.verdict === "VERIFIED") {
    state.mode.completion_claimed = true;
    state.mode.validated = true;
  }

  saveOrchestratorState(state);

  // Build unified response
  return {
    action: baseResult.action,
    success: !baseResult.result?.error,
    result: baseResult.result,
    current_mode: currentMode,
    posture: postureInfo.posture,
    pushbacks,
    capture_proposals: captureProposals,
    transition_hint: transitionHint,
    transition_available: getAvailableTransitions(currentMode, state.mode),
    assistant_text: buildUnifiedAssistantText(
      baseResult,
      postureInfo,
      pushbacks,
      captureProposals,
      transitionHint,
    ),
    debug: {
      ...baseResult.debug,
      orchestrator: {
        mode: currentMode,
        posture: postureInfo.posture.pushback_style,
        smells_detected: smells.length,
        pushbacks_count: pushbacks.length,
        session_id: state.session_id,
      },
    },
  };
}

/**
 * Detect action from message (wrapper for base detectAction).
 */
function detectActionFromMessage(message) {
  if (!message) return ACTIONS.LIBRARIAN;
  const detected = detectAction(message);
  return detected.action;
}

/**
 * Get confidence level from state.
 */
function getConfidenceFromState(modeState) {
  if (modeState.locked_decisions && modeState.locked_decisions.length > 2) {
    return "high";
  }
  if (modeState.locked_decisions && modeState.locked_decisions.length > 0) {
    return "medium";
  }
  if (modeState.captured_requirements && modeState.captured_requirements.length > 0) {
    return "low";
  }
  return "exploratory";
}

/**
 * Build unified assistant text combining base result with orchestrator additions.
 */
function buildUnifiedAssistantText(
  baseResult,
  postureInfo,
  pushbacks,
  captureProposals,
  transitionHint,
) {
  const parts = [];

  // Add pushbacks first (discovery mode adversarial feedback)
  if (pushbacks.length > 0) {
    parts.push("Before proceeding:");
    for (const p of pushbacks) {
      parts.push(`- ${p.message}`);
    }
    parts.push("");
  }

  // Add base result
  if (baseResult.assistant_text) {
    parts.push(baseResult.assistant_text);
  }

  // Add transition hint if detected
  if (transitionHint && transitionHint.detected_intent) {
    parts.push("");
    if (transitionHint.available) {
      parts.push(`It sounds like you're ready to move to ${transitionHint.detected_intent} mode.`);
      parts.push(`Use transition_to: "${transitionHint.detected_intent}" to confirm.`);
    } else {
      parts.push(`Transition to ${transitionHint.detected_intent} mode not yet available.`);
      parts.push(`Missing: ${transitionHint.missing.join("; ")}`);
    }
  }

  // Add capture proposals (Scribe detected learnings/decisions)
  if (captureProposals.length > 0) {
    parts.push("");
    parts.push("---");
    parts.push("I noticed something worth capturing:");
    for (const p of captureProposals) {
      parts.push(`- ${p.consent_prompt}`);
    }
    parts.push("Use capture_consent: true with capture_entry to record.");
  }

  return parts.join("\n").trim();
}

/**
 * Build text for blocked transition.
 */
function buildTransitionBlockedText(result, fromMode, toMode) {
  const lines = [];
  lines.push(`Cannot transition from ${fromMode} to ${toMode}.`);
  lines.push("");
  lines.push("Missing requirements:");
  for (const m of result.missing) {
    lines.push(`- ${m}`);
  }
  return lines.join("\n");
}

/**
 * Build text for completed transition.
 */
function buildTransitionCompleteText(fromMode, toMode, newPosture) {
  const lines = [];
  lines.push(`Transitioned from ${fromMode} to ${toMode}.`);
  lines.push("");
  lines.push(`New posture: ${newPosture.posture.description}`);
  lines.push("");
  lines.push("Available actions:");
  for (const action of newPosture.valid_actions) {
    lines.push(`- ${action}`);
  }
  return lines.join("\n");
}

/**
 * Build text for blocked action.
 */
function buildActionBlockedText(gate, mode, action) {
  const lines = [];
  lines.push(`Action '${action}' is not valid in ${mode} mode.`);
  lines.push("");
  if (gate.suggestion) {
    lines.push(gate.suggestion);
  }
  return lines.join("\n");
}

// Re-export for convenience
export { ACTIONS } from "../mcp/orchestrate.js";
export { MODES, getModeConfig, createModeState } from "./mode.js";
export { detectSmells, proposeCapture, writeLedgerEntry } from "./scribe.js";
export { canTransition, getAvailableTransitions } from "./transitions.js";
