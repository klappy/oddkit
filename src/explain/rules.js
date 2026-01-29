/**
 * Rule code mappings for explain
 *
 * Each rule has:
 * - title: Short human-readable name
 * - meaning: What this rule enforces or indicates
 */
export const RULES = {
  // Librarian rules
  SUPPORTED_REQUIRES_EVIDENCE_BULLETS: {
    title: "SUPPORTED requires evidence bullets",
    meaning:
      "A SUPPORTED answer must include at least 2 evidence bullets with quotes and path#heading citations.",
  },
  QUOTE_LENGTH_ENFORCED: {
    title: "Quote length enforced",
    meaning:
      "Quotes must be between 8 and 40 words to prevent token-laundering and meaningless fragments.",
  },
  INSUFFICIENT_EVIDENCE_RETURNED: {
    title: "Insufficient evidence returned",
    meaning: "The tool could not produce enough cited evidence, so it refused to claim an answer.",
  },
  SUPERSEDES_APPLIED: {
    title: "Supersedes override applied",
    meaning:
      "A local document explicitly superseded baseline content and the baseline doc was suppressed.",
  },
  BASELINE_UNAVAILABLE: {
    title: "Baseline unavailable",
    meaning:
      "Could not load baseline knowledge (git clone failed or network unavailable). Results are local-only.",
  },
  BASELINE_LOADED: {
    title: "Baseline loaded",
    meaning:
      "Baseline knowledge from klappy.dev was successfully loaded and merged with local docs.",
  },
  POLICY_INTENT_STRONG: {
    title: "Strong policy intent detected",
    meaning:
      "Query explicitly references policy/canon/rules. Governing documents were prioritized.",
  },
  POLICY_INTENT_WEAK: {
    title: "Weak policy intent detected",
    meaning: "Query implies policy interest. Governing documents received a soft preference.",
  },
  POLICY_INTENT_NONE: {
    title: "No policy intent detected",
    meaning: "Query appears to be general lookup. No special policy filtering applied.",
  },

  // Arbitration rules (per canon/weighted-relevance-and-arbitration.md)
  INTENT_GATED_PRECEDENCE: {
    title: "Intent-gated precedence active (hard veto)",
    meaning:
      "Per Canon: workaround/experiment cannot outrank promoted/pattern without explicit supersedes. Enforced as post-filter veto, not multiplier.",
  },
  INTENT_PRECEDENCE_VIOLATED: {
    title: "Intent precedence violation detected",
    meaning:
      "A lower-intent document (workaround/experiment) ranked above a higher-intent document without supersedes. See contradictions.",
  },
  INTENT_PRECEDENCE_VETOED: {
    title: "Items demoted by intent veto",
    meaning:
      "One or more low-intent items were forcibly demoted below high-intent items to enforce Canon invariant.",
  },
  LOW_CONFIDENCE_ADVISORY: {
    title: "Low confidence — advisory result",
    meaning:
      "Per Canon: confidence is low due to weak margin, weak evidence, or conflicts. Result is advisory, not authoritative.",
  },
  ESCALATION_REQUIRED: {
    title: "Escalation required",
    meaning:
      "Per Canon: contradictions exist and confidence is low. Human judgment is required to resolve.",
  },
  PROMOTION_CANDIDATE: {
    title: "Promotion candidate detected",
    meaning:
      "Per Canon: contradictions exist but confidence is sufficient. This pattern may warrant promotion to Canon.",
  },
  IDENTITY_DEDUP: {
    title: "Identity dedup active",
    meaning:
      "Duplicate candidates (same URI or path) are collapsed before scoring. This removes artifact ambiguity so conflict means real disagreement.",
  },
  INDEX_DUPLICATE_COLLAPSED: {
    title: "Duplicates collapsed",
    meaning:
      "One or more duplicate identity groups were found and collapsed. Consider adding uri or supersedes to make identity explicit.",
  },
  EXCESSIVE_DUPLICATES: {
    title: "Excessive duplicates detected",
    meaning:
      "More than 25% of candidates were duplicates. Baseline and local repos overlap heavily. Consider pinning baseline ref or reducing baseline scope.",
  },
  IDENTITY_COLLISION_DETECTED: {
    title: "URI collision with content mismatch",
    meaning:
      "Multiple docs share the same URI but have different content. This is a metadata error — URIs must be unique identities. Fix the conflicting documents.",
  },

  // Validation rules
  VALIDATION_CLAIMS_PARSED: {
    title: "Claims parsed from message",
    meaning: "Completion claims were detected and extracted from your message.",
  },
  VALIDATION_NEEDS_ARTIFACTS: {
    title: "Completion claim needs artifacts",
    meaning: "You claimed completion but did not provide the required artifacts to verify it.",
  },
  VALIDATION_PASS: {
    title: "Validation passed",
    meaning: "All required evidence was provided and matched the claims.",
  },
  VALIDATION_FAIL: {
    title: "Validation failed",
    meaning: "Evidence contradicts the claim or indicates breakage.",
  },
  VALIDATION_CLARIFY: {
    title: "Clarification needed",
    meaning: "No clear completion claim was detected. Please clarify what you completed.",
  },
  VALIDATION_NO_COMPLETION_CLAIM: {
    title: "No completion claim detected",
    meaning: "The message did not contain a recognizable completion assertion.",
  },

  // Index rules
  INDEX_BUILT: {
    title: "Index built successfully",
    meaning: "Document index was created or updated.",
  },
  INDEX_BASELINE_INCLUDED: {
    title: "Baseline included in index",
    meaning: "Baseline knowledge was merged into the index.",
  },
};

/**
 * Get rule description by code
 * Returns null if unknown
 */
export function getRule(code) {
  return RULES[code] || null;
}

/**
 * Check if a rule code is known
 */
export function isKnownRule(code) {
  return code in RULES;
}
