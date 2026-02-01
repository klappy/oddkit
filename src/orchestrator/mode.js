/**
 * Mode definitions for the ODD Orchestrator.
 *
 * Three non-collapsible modes with distinct postures:
 * - Discovery: High fuzziness tolerance, constructive adversarial pushback
 * - Planning: Options crystallizing, decisions locking
 * - Execution: Concrete, locked, artifact delivery
 */

export const MODES = {
  DISCOVERY: {
    name: "discovery",
    posture: {
      fuzziness_tolerance: "high",
      pushback_style: "constructive_adversarial",
      structure_enforcement: "minimal",
      description: "Thinking-first. Nothing committed. Messy allowed.",
      suggestions: [
        "What happens if X?",
        "Have you considered Y?",
        "What evidence supports this?",
        "What problem are we solving?",
      ],
    },
    valid_actions: ["orient", "catalog", "librarian", "preflight"],
    blocked_actions: ["validate"],
    transition_requirements: {
      to_planning: ["requirements_captured", "scope_defined"],
    },
  },
  PLANNING: {
    name: "planning",
    posture: {
      fuzziness_tolerance: "medium",
      pushback_style: "crystallizing",
      structure_enforcement: "moderate",
      description: "Options crystallizing. Decisions locking. Constraints surfacing.",
      suggestions: [
        "Lock this decision",
        "What constraint applies?",
        "Define the Definition of Done",
        "What are the tradeoffs?",
      ],
    },
    valid_actions: ["orient", "catalog", "librarian", "preflight"],
    blocked_actions: ["validate"],
    transition_requirements: {
      to_execution: ["dod_defined", "constraints_captured", "decisions_locked"],
    },
  },
  EXECUTION: {
    name: "execution",
    posture: {
      fuzziness_tolerance: "low",
      pushback_style: "concrete",
      structure_enforcement: "strict",
      description: "Concrete. Locked. Delivering artifacts.",
      suggestions: [
        "Show me the artifact",
        "What evidence proves completion?",
        "Does this satisfy the Definition of Done?",
      ],
    },
    valid_actions: ["librarian", "validate", "preflight"],
    blocked_actions: [],
    transition_requirements: {
      to_discovery: ["completion_claimed", "validated"],
    },
  },
};

/**
 * Get mode configuration by name (case-insensitive).
 */
export function getModeConfig(modeName) {
  if (!modeName) return null;
  return MODES[modeName.toUpperCase()] || null;
}

/**
 * Create fresh mode state for a new session.
 */
export function createModeState(initial = "discovery") {
  return {
    current_mode: initial,
    entered_at: new Date().toISOString(),
    transition_history: [],
    locked_decisions: [],
    captured_requirements: [],
    dod_defined: false,
    constraints_captured: [],
    scope: null,
    completion_claimed: false,
    validated: false,
  };
}

/**
 * Get the canonical URI for a mode.
 */
export function getModeUri(modeName) {
  return `klappy://canon/epistemic-modes#${modeName.toLowerCase()}`;
}
