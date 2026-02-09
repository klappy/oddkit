// src/mcp/instructions.js

/**
 * Machine-stable contract for instruction invariants.
 * Tests assert on these keys, allowing prose to evolve safely.
 * Changes here require test updates - that's intentional.
 */
export const INSTRUCTION_CONTRACT = {
  NO_PASTE_LARGE_CANON: true,
  RETRIEVE_AND_QUOTE: true,
  REPO_ROOT_REQUIRED: true,
  ORCHESTRATE_IS_ENTRY: true,
  DECISION_GATE_PATTERN: true,
};

/**
 * Returns the always-on ODD decision gate instructions for MCP clients.
 * These instructions teach agents WHEN to call oddkit, not WHAT the rules are.
 * Kept SHORT and IMPERATIVE so models actually follow them.
 *
 * Per CHARTER.md: oddkit is epistemic terrain rendering.
 * It renders the map. Upstream agents (Epistemic Guide) are the compass.
 */
export function getOddkitInstructions() {
  const instructions = `
ODDKIT DECISION GATE

You have access to oddkit_orchestrate for policy retrieval and completion validation.

CRITICAL MOMENTS (MUST call oddkit):

1. BEFORE IMPLEMENTING: Call oddkit_orchestrate({ message: "preflight: <plan>", repo_root: "." })
   → Returns: Start here / Constraints / DoD / Pitfalls

2. BEFORE CLAIMING DONE: Call oddkit_orchestrate({ message: "done: <claim> [artifacts]", repo_root: "." })
   → If NEEDS_ARTIFACTS: provide missing evidence before asserting completion

CALL oddkit_orchestrate WHEN:
- Policy questions ("what's the rule?", "is this allowed?")
- Low confidence or contradictions
- Discoverability ("what's in ODD?", "list canon")
- Orientation (pass action="orient" explicitly)

EPISTEMIC GUIDE TOOLS (also available as standalone):
- oddkit_orient: Assess a goal/situation, detect epistemic mode, surface assumptions
- oddkit_challenge: Pressure-test a claim or proposal against canon constraints
- oddkit_gate: Check transition prerequisites before changing modes
- oddkit_encode: Structure a decision as a durable record

RESPONSE HANDLING:
- Use the "assistant_text" field directly - it's a complete answer with citations
- Don't add extra narration - print assistant_text verbatim

ACTION PARAMETER (optional):
- Without action: oddkit detects intent from message
- Explicit: action="orient|challenge|gate|encode|preflight|catalog|librarian|validate|explain"

FOR SPAWNED AGENTS:
- You inherit oddkit access from parent context
- Read oddkit://quickstart resource for usage patterns
- Always pass repo_root when calling tools

NEVER pre-inject large documents. Retrieve on-demand via oddkit_orchestrate.
`.trim();

  if (process.env.ODDKIT_DEBUG_MCP) {
    console.error(`oddkit: served instructions tag=ODDKIT_GATE_v0.6.0 len=${instructions.length}`);
  }

  return instructions;
}
