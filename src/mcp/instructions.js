// src/mcp/instructions.js

/**
 * Returns the always-on ODD decision gate instructions for MCP clients.
 * These instructions teach agents WHEN to call oddkit, not WHAT the rules are.
 * Kept SHORT and IMPERATIVE so models actually follow them.
 */
export function getOddkitInstructions() {
  const instructions = `
ODDKIT DECISION GATE

MUST: Before editing files or implementing a spec, call oddkit_orchestrate with your implementation plan.
Use the returned Start here / Constraints / DoD / Pitfalls to guide your work.

MUST: Before claiming done/fixed/shipped/merged, call oddkit_orchestrate with your completion claim + artifacts.
If it returns NEEDS_ARTIFACTS, provide missing evidence before asserting completion.

Call oddkit_orchestrate when:
- Policy/canon questions ("what's the rule?", "is this allowed?")
- Contradictions or low confidence
- Discoverability ("what's in ODD?", "list canon", "what should I read?")

Do NOT pre-inject docs. Retrieve minimal excerpts via oddkit, quote with citations.
`.trim();

  if (process.env.ODDKIT_DEBUG_MCP) {
    console.error(`oddkit: served instructions tag=ODDKIT_GATE_v0.3.0 len=${instructions.length}`);
  }

  return instructions;
}
