/**
 * Guide role for the ODD Orchestrator.
 *
 * The Guide:
 * - Applies mode-appropriate posture
 * - Gates actions that are invalid for current mode
 * - Provides constructive adversarial pushback in discovery
 * - Refuses premature execution firmly but politely
 */

import { getModeConfig } from "./mode.js";

/**
 * Apply mode-appropriate posture.
 * Returns posture configuration for the given mode.
 */
export function applyPosture(mode, state) {
  const config = getModeConfig(mode);
  if (!config) {
    return {
      posture: { fuzziness_tolerance: "medium", pushback_style: "neutral" },
      valid_actions: ["librarian", "catalog", "preflight"],
      blocked_actions: [],
      suggestions: [],
    };
  }

  return {
    posture: config.posture,
    valid_actions: config.valid_actions,
    blocked_actions: config.blocked_actions,
    suggestions: config.posture.suggestions,
  };
}

/**
 * Gate an action against current mode.
 * Returns { allowed, reason, suggestion }
 */
export function gateAction(action, mode, state) {
  const config = getModeConfig(mode);

  if (!config) {
    return { allowed: true, reason: null, suggestion: null };
  }

  if (config.blocked_actions.includes(action)) {
    return {
      allowed: false,
      reason: `Action '${action}' is not valid in ${mode} mode`,
      suggestion: getSuggestionForBlockedAction(action, mode, state),
    };
  }

  return { allowed: true, reason: null, suggestion: null };
}

/**
 * Get a helpful suggestion when an action is blocked.
 */
function getSuggestionForBlockedAction(action, mode, state) {
  if (action === "validate") {
    if (mode === "discovery") {
      return "Discovery mode is for exploration. Capture requirements and define scope first, then transition to planning.";
    }
    if (mode === "planning") {
      return "Planning mode requires locking decisions before execution. Define the Definition of Done, capture constraints, and lock at least one decision.";
    }
  }

  return `Try one of the valid actions for ${mode} mode`;
}

/**
 * Refuse premature execution.
 * Checks if all execution prerequisites are met.
 * Returns { refused, message, missing }
 */
export function refusePrematureExecution(state) {
  const missing = [];

  if (!state.dod_defined) {
    missing.push("Definition of Done not yet established");
  }
  if (!state.constraints_captured || state.constraints_captured.length === 0) {
    missing.push("No constraints have been captured");
  }
  if (!state.locked_decisions || state.locked_decisions.length === 0) {
    missing.push("No decisions have been locked");
  }

  return {
    refused: missing.length > 0,
    message:
      missing.length > 0
        ? `Cannot proceed to execution. Missing: ${missing.join("; ")}. Let's complete planning first.`
        : null,
    missing,
  };
}

/**
 * Constructive adversarial pushback in discovery mode.
 * Detects patterns that suggest premature certainty or solution-jumping.
 * Returns array of { type, message }
 */
export function discoveryPushback(message, state) {
  const pushbacks = [];

  if (!message) return pushbacks;

  // Detect premature certainty
  const certaintyPatterns = /\b(definitely|always|never|must|certainly|obviously)\b/i;
  if (
    certaintyPatterns.test(message) &&
    (!state.captured_requirements || state.captured_requirements.length < 2)
  ) {
    pushbacks.push({
      type: "certainty_check",
      message:
        "Strong certainty language detected early in discovery. What evidence supports this?",
    });
  }

  // Detect jumping to solution/implementation
  const implementationPatterns = /\b(implement|build|code|create the|write the|add the)\b/i;
  if (implementationPatterns.test(message) && !state.dod_defined) {
    pushbacks.push({
      type: "premature_execution",
      message:
        "Implementation language detected before requirements are clear. What problem are we solving?",
    });
  }

  // Detect scope creep signals
  const scopeCreepPatterns = /\b(also|and then|while we're at it|might as well)\b/i;
  if (scopeCreepPatterns.test(message) && state.scope) {
    pushbacks.push({
      type: "scope_creep",
      message:
        "This sounds like scope expansion. Is this within the defined scope, or a new discovery?",
    });
  }

  return pushbacks;
}

/**
 * Check if a message indicates a mode transition intent.
 * Returns { detected, to_mode, confidence }
 */
export function detectTransitionIntent(message) {
  if (!message) return { detected: false, to_mode: null, confidence: 0 };

  const m = message.toLowerCase();

  // Planning transition signals
  if (/\b(let's plan|ready to plan|move to planning|start planning)\b/i.test(m)) {
    return { detected: true, to_mode: "planning", confidence: 0.8 };
  }

  // Execution transition signals
  if (/\b(let's build|ready to implement|start coding|move to execution)\b/i.test(m)) {
    return { detected: true, to_mode: "execution", confidence: 0.8 };
  }

  // Discovery reset signals
  if (/\b(start over|back to discovery|rethink|new approach)\b/i.test(m)) {
    return { detected: true, to_mode: "discovery", confidence: 0.7 };
  }

  return { detected: false, to_mode: null, confidence: 0 };
}
