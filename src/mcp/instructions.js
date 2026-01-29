// src/mcp/instructions.js

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

MUST: Before editing files or implementing a spec, call oddkit_orchestrate with your implementation plan.
Use the returned Start here / Constraints / DoD / Pitfalls to guide your work.

MUST: Before claiming done/fixed/shipped/merged, call oddkit_orchestrate with your completion claim + artifacts.
If it returns NEEDS_ARTIFACTS, provide missing evidence before asserting completion.

Call oddkit_orchestrate when:
- Policy/canon questions ("what's the rule?", "is this allowed?")
- Contradictions or low confidence
- Discoverability ("what's in ODD?", "list canon", "what should I read?")
- Orientation (pass action="orient" explicitly to render epistemic terrain)

Action parameter:
- Pass action="orient" to explicitly request orientation (oddkit does NOT infer this from message)
- Pass action="preflight|catalog|librarian|validate|explain" to force a specific action
- Without action, oddkit detects from message content (but never detects ORIENT)

Epistemic context (optional):
- Pass epistemic.mode_ref (canon URI) and epistemic.confidence when known
- Example: { "mode_ref": "klappy://canon/epistemic-modes#exploration", "confidence": "low" }
- Upstream agents (Epistemic Guide) determine mode; oddkit just adapts to it

Do NOT pre-inject docs. Retrieve minimal excerpts via oddkit, quote with citations.
`.trim();

  if (process.env.ODDKIT_DEBUG_MCP) {
    console.error(`oddkit: served instructions tag=ODDKIT_GATE_v0.5.0 len=${instructions.length}`);
  }

  return instructions;
}
