/**
 * Mode transition rules and gates for the ODD Orchestrator.
 *
 * Transitions between modes are gated by requirements:
 * - Discovery -> Planning: requirements captured, scope defined
 * - Planning -> Execution: DoD defined, constraints captured, decisions locked
 * - Execution -> Discovery: completion claimed and validated
 */

import { getModeConfig } from "./mode.js";

/**
 * Check if a mode transition is valid.
 * Returns { valid, reason, missing }
 */
export function canTransition(from, to, state) {
  const fromConfig = getModeConfig(from);
  if (!fromConfig) {
    return { valid: false, reason: `Unknown mode: ${from}`, missing: [] };
  }

  const requirements = fromConfig.transition_requirements[`to_${to}`];
  if (!requirements) {
    return {
      valid: false,
      reason: `No transition path from ${from} to ${to}`,
      missing: [],
    };
  }

  const missing = checkRequirements(requirements, state);

  if (missing.length > 0) {
    return {
      valid: false,
      reason: `Missing requirements for ${from} -> ${to} transition`,
      missing,
    };
  }

  return { valid: true, reason: null, missing: [] };
}

/**
 * Execute a mode transition.
 * Returns { success, state?, error?, missing? }
 */
export function executeTransition(from, to, state, reason) {
  const check = canTransition(from, to, state);
  if (!check.valid) {
    return { success: false, error: check.reason, missing: check.missing };
  }

  const newState = {
    ...state,
    current_mode: to,
    entered_at: new Date().toISOString(),
    transition_history: [
      ...state.transition_history,
      { from, to, at: new Date().toISOString(), reason },
    ],
  };

  // Reset mode-specific state on transition to discovery
  if (to === "discovery") {
    newState.captured_requirements = [];
    newState.locked_decisions = [];
    newState.dod_defined = false;
    newState.constraints_captured = [];
    newState.scope = null;
    newState.completion_claimed = false;
    newState.validated = false;
  }

  return { success: true, state: newState };
}

/**
 * Check requirements against state.
 * Returns array of missing requirement descriptions.
 */
function checkRequirements(requirements, state) {
  const missing = [];

  for (const req of requirements) {
    switch (req) {
      case "requirements_captured":
        if (!state.captured_requirements || state.captured_requirements.length < 1) {
          missing.push("At least one requirement must be captured");
        }
        break;
      case "scope_defined":
        if (!state.scope) {
          missing.push("Scope must be defined");
        }
        break;
      case "dod_defined":
        if (!state.dod_defined) {
          missing.push("Definition of Done must be established");
        }
        break;
      case "constraints_captured":
        if (!state.constraints_captured || state.constraints_captured.length < 1) {
          missing.push("At least one constraint must be captured");
        }
        break;
      case "decisions_locked":
        if (!state.locked_decisions || state.locked_decisions.length < 1) {
          missing.push("At least one decision must be locked");
        }
        break;
      case "completion_claimed":
        if (!state.completion_claimed) {
          missing.push("Completion must be claimed");
        }
        break;
      case "validated":
        if (!state.validated) {
          missing.push("Validation must pass");
        }
        break;
      default:
        missing.push(`Unknown requirement: ${req}`);
    }
  }

  return missing;
}

/**
 * Get available transitions from current mode with their requirements status.
 */
export function getAvailableTransitions(currentMode, state) {
  const config = getModeConfig(currentMode);
  if (!config) return [];

  const transitions = [];

  for (const [key, requirements] of Object.entries(config.transition_requirements)) {
    const targetMode = key.replace("to_", "");
    const check = canTransition(currentMode, targetMode, state);
    transitions.push({
      to: targetMode,
      available: check.valid,
      missing: check.missing || [],
    });
  }

  return transitions;
}
