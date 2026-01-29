import { buildIndex, loadIndex, saveIndex, INTENT_HIERARCHY } from "../index/buildIndex.js";
import { ensureBaselineRepo, getBaselineRef } from "../baseline/ensureBaselineRepo.js";
import { applySupersedes } from "../resolve/applySupersedes.js";
import { tokenize, scoreDocument, findBestHeading } from "../utils/scoring.js";
import { extractQuote, formatCitation, MIN_QUOTE_WORDS, countWords } from "../utils/slicing.js";
import { writeLast } from "../state/last.js";

const MIN_EVIDENCE_BULLETS = 2;
const MAX_RESULTS = 5;
const MIN_CONFIDENCE_THRESHOLD = 0.6; // Below this, result is advisory

/**
 * Compute candidate identity key for dedup
 * Precedence: uri > normalized path
 *
 * Duplicates are an identity/equivalence issue, not a semantic override.
 * This is different from supersedes (which is semantic override of different docs).
 */
function computeIdentityKey(doc) {
  // 1. If uri exists, use it (stable across origins)
  if (doc.uri) {
    return doc.uri;
  }
  // 2. Else use normalized path (relative to repo root, origin-agnostic)
  // Normalize by removing origin-specific prefixes
  return doc.path;
}

/**
 * Collapse duplicates by identity key, pick representative
 *
 * Tie-breaker for representative selection (principled):
 * 1. Origin: local > baseline
 * 2. Authority: governing > operational > non-governing
 * 3. Evidence: strong > medium > weak > none
 * 4. Intent: promoted > pattern > operational > experiment > workaround
 *
 * This is not "forced convergence" — it's treating duplicates as duplicates.
 * Per canon/weighted-relevance-and-arbitration.md: this removes artifact ambiguity
 * so "conflict" means real disagreement, not index hygiene.
 */
function deduplicateCandidates(docs) {
  const groups = new Map(); // id -> docs[]

  // Group by identity key
  for (const doc of docs) {
    const id = computeIdentityKey(doc);
    if (!groups.has(id)) {
      groups.set(id, []);
    }
    groups.get(id).push(doc);
  }

  const deduplicated = [];
  const collapsedGroups = [];

  for (const [id, groupDocs] of groups) {
    if (groupDocs.length === 1) {
      // No duplicates, keep as-is
      deduplicated.push(groupDocs[0]);
    } else {
      // Multiple docs with same identity — pick representative
      const sorted = groupDocs.sort((a, b) => {
        // 1. Origin: local > baseline
        if (a.origin !== b.origin) {
          return a.origin === "local" ? -1 : 1;
        }
        // 2. Authority: governing > operational > non-governing
        const authOrder = { governing: 0, operational: 1, "non-governing": 2 };
        const authA = authOrder[a.authority_band] ?? 1;
        const authB = authOrder[b.authority_band] ?? 1;
        if (authA !== authB) return authA - authB;
        // 3. Evidence: strong > medium > weak > none
        const evOrder = { strong: 0, medium: 1, weak: 2, none: 3 };
        const evA = evOrder[a.evidence] ?? 3;
        const evB = evOrder[b.evidence] ?? 3;
        if (evA !== evB) return evA - evB;
        // 4. Intent: promoted > pattern > operational > experiment > workaround
        const intA = INTENT_HIERARCHY[a.intent] || 3;
        const intB = INTENT_HIERARCHY[b.intent] || 3;
        return intB - intA; // Higher intent wins
      });

      const chosen = sorted[0];
      const collapsed = sorted.slice(1);

      deduplicated.push(chosen);
      collapsedGroups.push({
        id,
        chosen: { origin: chosen.origin, path: chosen.path },
        collapsed: collapsed.map((d) => ({ origin: d.origin, path: d.path })),
      });
    }
  }

  return {
    docs: deduplicated,
    collapsedGroups,
    duplicateCount: docs.length - deduplicated.length,
  };
}

/**
 * Detect policy intent from query
 */
function detectPolicyIntent(query) {
  const lower = query.toLowerCase();
  const strongPatterns = [
    /\b(?:odd|canon)\s+says\b/i,
    /\b(?:rule|constraint|decision|definition|policy)\b/i,
    /\bwhat\s+(?:is|are)\s+the\s+(?:rule|constraint|requirement)/i,
  ];
  const weakPatterns = [/\bmust\b/i, /\bshould\b/i, /\brequire/i, /\beverify/i, /\bevidence\b/i];

  if (strongPatterns.some((p) => p.test(query))) {
    return "strong";
  }
  if (weakPatterns.some((p) => p.test(query))) {
    return "weak";
  }
  return "none";
}

/**
 * Apply intent-gated precedence as HARD VETO (per canon/weighted-relevance-and-arbitration.md)
 *
 * INVARIANT: If any candidate has intent: promoted|pattern, then any candidate
 * with intent: workaround|experiment MUST NOT rank above it unless supersedes
 * explicitly applies.
 *
 * This is a post-filter veto, not a multiplier - multipliers are easy to bypass.
 *
 * Returns: { reordered: candidates[], violations: [], vetoed: [] }
 */
function applyIntentGatedPrecedence(candidates) {
  const violations = [];
  const vetoed = [];

  // Separate by intent tier
  const highIntent = []; // promoted, pattern (intent >= 4)
  const lowIntent = []; // workaround, experiment (intent <= 2)
  const midIntent = []; // operational (intent == 3)

  for (const c of candidates) {
    const intentLevel = INTENT_HIERARCHY[c.doc.intent] || 3;
    if (intentLevel >= 4) {
      highIntent.push(c);
    } else if (intentLevel <= 2) {
      lowIntent.push(c);
    } else {
      midIntent.push(c);
    }
  }

  // Check if any low-intent items were originally ranked above high-intent items
  for (const low of lowIntent) {
    const lowOriginalRank = candidates.indexOf(low);

    for (const high of highIntent) {
      const highOriginalRank = candidates.indexOf(high);

      // If low-intent was ranked higher (lower index) than high-intent
      if (lowOriginalRank < highOriginalRank) {
        // Check if low explicitly supersedes high
        const lowSupersedes = low.doc.supersedes;
        const highUri = high.doc.uri;

        if (!lowSupersedes || lowSupersedes !== highUri) {
          violations.push({
            lowIntent: low.doc.path,
            lowIntentType: low.doc.intent,
            highIntent: high.doc.path,
            highIntentType: high.doc.intent,
            original_rank_low: lowOriginalRank,
            original_rank_high: highOriginalRank,
          });

          // VETO: Mark this low-intent item for demotion
          if (!vetoed.includes(low)) {
            vetoed.push(low);
          }
        }
      }
    }
  }

  // HARD REORDER: high-intent first, then mid, then low (preserving internal order)
  // But only demote items that violated - don't reorder everything
  const reordered = [];
  for (const c of candidates) {
    if (!vetoed.includes(c)) {
      reordered.push(c);
    }
  }
  // Add vetoed items at the end
  reordered.push(...vetoed);

  return { reordered, violations, vetoed: vetoed.map((v) => v.doc.path) };
}

/**
 * Calculate confidence level based on visible, reproducible factors
 * Per canon/weighted-relevance-and-arbitration.md: confidence must be:
 * - Computed from visible factors only (no hidden heuristics)
 * - Reproducible given same index + query + baseline ref
 * - Explainable by listing dominant terms
 *
 * Formula: margin-based + coverage penalties + conflict penalties
 */
function calculateConfidence(scored, evidence, contradictions = []) {
  const factors = {
    margin: 0,
    coverage: 0,
    conflict_penalty: 0,
    evidence_quality: 0,
    intent_quality: 0,
  };

  if (evidence.length === 0 || scored.length === 0) {
    return { confidence: 0, confidenceFactors: factors };
  }

  // 1. MARGIN-BASED: separation between top candidates
  // If top score is much higher than second, we're more confident
  if (scored.length >= 2) {
    const topScore = scored[0].score;
    const secondScore = scored[1].score;
    factors.margin = topScore > 0 ? (topScore - secondScore) / topScore : 0;
  } else {
    factors.margin = 1.0; // Only one candidate = high margin by default
  }

  // 2. COVERAGE: do we have enough evidence bullets?
  factors.coverage = Math.min(1.0, evidence.length / MIN_EVIDENCE_BULLETS);

  // 3. CONFLICT PENALTY: contradictions reduce confidence
  factors.conflict_penalty = contradictions.length > 0 ? 0.3 * contradictions.length : 0;

  // 4. EVIDENCE QUALITY: strong evidence increases confidence
  const evidenceWeights = { none: 0.5, weak: 0.7, medium: 0.9, strong: 1.0 };
  const avgEvidenceQuality =
    scored.slice(0, evidence.length).reduce((sum, s) => {
      return sum + (evidenceWeights[s.doc.evidence] || 0.7);
    }, 0) / Math.max(1, evidence.length);
  factors.evidence_quality = avgEvidenceQuality;

  // 5. INTENT QUALITY: higher intent (promoted/pattern) increases confidence
  const avgIntentQuality =
    scored.slice(0, evidence.length).reduce((sum, s) => {
      const intLevel = INTENT_HIERARCHY[s.doc.intent] || 3;
      return sum + intLevel / 5; // Normalize to 0-1
    }, 0) / Math.max(1, evidence.length);
  factors.intent_quality = avgIntentQuality;

  // Final confidence: weighted combination
  // margin (40%) + coverage (20%) + evidence_quality (20%) + intent_quality (20%) - conflicts
  const rawConfidence =
    factors.margin * 0.4 +
    factors.coverage * 0.2 +
    factors.evidence_quality * 0.2 +
    factors.intent_quality * 0.2 -
    factors.conflict_penalty;

  const confidence = Math.min(1.0, Math.max(0, rawConfidence));

  return { confidence: Math.round(confidence * 100) / 100, confidenceFactors: factors };
}

/**
 * Run the librarian command
 */
export async function runLibrarian(options) {
  const { query, repo: repoRoot } = options;

  // Ensure baseline
  const baseline = await ensureBaselineRepo();
  const baselineRef = getBaselineRef();
  const baselineAvailable = !!baseline.root;

  // Load or build index with strict baseline gating
  let index = loadIndex(repoRoot);
  let indexRebuildReason = null;

  // Check if cached index is valid for current baseline state
  if (index) {
    const hasBaselineDocs = index.documents.some((d) => d.origin === "baseline");

    if (!baselineAvailable && hasBaselineDocs) {
      // Cached index has baseline docs but baseline is now unavailable
      // Must rebuild with local-only
      index = null;
      indexRebuildReason = "baseline_now_unavailable";
    } else if (baselineAvailable && !hasBaselineDocs) {
      // Cached index is local-only but baseline is now available
      // Rebuild to include baseline
      index = null;
      indexRebuildReason = "baseline_now_available";
    }
  }

  if (!index) {
    // Build fresh index - only include baseline if available
    index = await buildIndex(repoRoot, baselineAvailable ? baseline.root : null);
    saveIndex(index, repoRoot);
  }

  // Apply supersedes (semantic override of different docs)
  const { filtered: afterSupersedes, suppressed } = applySupersedes(index.documents);

  // Apply dedup (identity collapse of same docs across origins)
  // This is different from supersedes: dedup handles index hygiene, supersedes handles semantic override
  const { docs, collapsedGroups, duplicateCount } = deduplicateCandidates(afterSupersedes);

  // INVARIANT: If baseline unavailable, no docs should have origin:"baseline"
  if (!baselineAvailable) {
    const baselineDocsPresent = docs.some((d) => d.origin === "baseline");
    if (baselineDocsPresent) {
      throw new Error(
        "Invariant violated: baseline documents present in index while baseline is unavailable",
      );
    }
  }

  // Tokenize query
  const queryTokens = tokenize(query);

  // Score all documents (returns { score, signals })
  const allScored = docs.map((doc) => {
    const { score, signals } = scoreDocument(doc, queryTokens);
    return { doc, score, signals };
  });

  // Filter and sort
  const scored = allScored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS);

  // Apply intent-gated precedence as HARD VETO (per canon/weighted-relevance-and-arbitration.md)
  const {
    reordered: reorderedScored,
    violations: precedenceViolations,
    vetoed,
  } = applyIntentGatedPrecedence(scored);

  // Use reordered list for evidence building
  const finalScored = reorderedScored;

  // Build candidates considered (for output contract 2.3)
  const candidatesConsidered = finalScored.map((s) => ({
    path: s.doc.path,
    origin: s.doc.origin,
    score: Math.round(s.score * 100) / 100,
    intent: s.doc.intent,
    evidence: s.doc.evidence,
    authority: s.doc.authority_band,
    signals: s.signals,
  }));

  // Build evidence bullets with rejection tracking
  const evidence = [];
  const sources = [];
  const rejectionReasons = {
    NO_HEADING: 0,
    TOO_SHORT: 0,
    DUPLICATE_PATH_HEADING: 0,
    DUPLICATE_PATH_DIVERSITY: 0,
  };
  // Track seen (path, heading) pairs for hard dedup
  const seenPathHeading = new Set();
  // Track seen paths for diversity preference (soft dedup when we have enough)
  const seenPaths = new Set();

  for (const { doc } of finalScored) {
    const heading = findBestHeading(doc, queryTokens);
    if (!heading) {
      rejectionReasons.NO_HEADING++;
      continue;
    }

    const quoteResult = extractQuote(doc, heading);
    // Use word count (MIN_QUOTE_WORDS = 8), not character count
    if (!quoteResult || quoteResult.wordCount < MIN_QUOTE_WORDS) {
      rejectionReasons.TOO_SHORT++;
      continue;
    }

    const citation = formatCitation(doc, heading);
    const pathHeadingKey = `${doc.path}::${heading.text}`;

    // Hard dedup: same path AND same heading is always rejected
    if (seenPathHeading.has(pathHeadingKey)) {
      rejectionReasons.DUPLICATE_PATH_HEADING++;
      continue;
    }

    // Soft dedup: same path but different heading
    // Only apply diversity preference if we already have enough evidence
    if (seenPaths.has(doc.path) && evidence.length >= MIN_EVIDENCE_BULLETS) {
      rejectionReasons.DUPLICATE_PATH_DIVERSITY++;
      continue;
    }

    seenPathHeading.add(pathHeadingKey);
    seenPaths.add(doc.path);

    evidence.push({
      quote: quoteResult.quote,
      citation,
      origin: doc.origin,
      intent: doc.intent,
      evidence_strength: doc.evidence,
      wordCount: quoteResult.wordCount,
      truncated: quoteResult.truncated,
    });

    sources.push(citation);
  }

  // Calculate evidence stats
  const evidenceAcceptedCount = evidence.length;
  const evidenceRejectedCount = Object.values(rejectionReasons).reduce((a, b) => a + b, 0);
  // Filter out zero counts
  const evidenceRejectedReasons = Object.fromEntries(
    Object.entries(rejectionReasons).filter(([, v]) => v > 0),
  );

  // Calculate confidence using margin-based approach (per canon/weighted-relevance-and-arbitration.md)
  // Confidence must be computed from visible factors only, reproducible, and explainable
  const { confidence, confidenceFactors } = calculateConfidence(
    finalScored,
    evidence,
    precedenceViolations,
  );
  const isConfident = confidence >= MIN_CONFIDENCE_THRESHOLD;

  // Determine status (SUPPORTED or INSUFFICIENT_EVIDENCE only - no third state)
  // Advisory flag is separate to prevent "basically supported" laundering
  let status;
  if (evidence.length >= MIN_EVIDENCE_BULLETS) {
    status = "SUPPORTED";
  } else {
    status = "INSUFFICIENT_EVIDENCE";
  }

  // Advisory flag - separate from status to prevent misuse
  const advisory = !isConfident;

  // Build answer (advisory is a separate flag, not a status)
  let answer;
  if (status === "SUPPORTED") {
    if (advisory) {
      answer = `Found ${evidence.length} relevant document(s) for: "${query}" [advisory: low confidence]`;
    } else {
      answer = `Found ${evidence.length} relevant document(s) for: "${query}"`;
    }
  } else {
    answer = `Could not find sufficient evidence to answer: "${query}". Found ${evidence.length} partial match(es).`;
  }

  // Detect contradictions with TYPED categories (per canon/weighted-relevance-and-arbitration.md)
  // Types: AUTHORITY_CONTRADICTION, EVIDENCE_CONTRADICTION, SCOPE_CONTRADICTION, TEMPORAL_DRIFT, STATE_CONTRADICTION
  const contradictions = [];

  // Authority contradictions: intent precedence violations
  if (precedenceViolations.length > 0) {
    for (const v of precedenceViolations) {
      contradictions.push({
        type: "AUTHORITY_CONTRADICTION",
        subtype: "INTENT_PRECEDENCE_VIOLATION",
        low_path: v.lowIntent,
        low_intent: v.lowIntentType,
        high_path: v.highIntent,
        high_intent: v.highIntentType,
        message: `${v.lowIntentType} (${v.lowIntent}) ranked above ${v.highIntentType} (${v.highIntent}) without explicit supersedes`,
        vetoed: vetoed.includes(v.lowIntent),
      });
    }
  }

  // Evidence contradictions: conflicting claims with no resolution
  const evidenceStrengths = evidence.map((e) => e.evidence_strength);
  if (evidenceStrengths.includes("strong") && evidenceStrengths.includes("none")) {
    contradictions.push({
      type: "EVIDENCE_CONTRADICTION",
      subtype: "MIXED_EVIDENCE_STRENGTH",
      message: "Evidence includes both strong and unsupported sources",
    });
  }

  // Index hygiene warnings (not blocking contradictions, but smells to track)
  const warnings = [];
  if (collapsedGroups.length > 0) {
    warnings.push({
      type: "INDEX_DUPLICATE",
      count: duplicateCount,
      message: `${duplicateCount} duplicate(s) collapsed from ${collapsedGroups.length} identity group(s). Consider adding uri or supersedes.`,
      groups: collapsedGroups,
    });
  }

  // Scope contradictions: local and baseline sources disagree
  const hasLocal = evidence.some((e) => e.origin === "local");
  const hasBaseline = evidence.some((e) => e.origin === "baseline");
  if (hasLocal && hasBaseline && evidence.length >= 2) {
    // Check if they have conflicting intents
    const localIntents = evidence.filter((e) => e.origin === "local").map((e) => e.intent);
    const baselineIntents = evidence.filter((e) => e.origin === "baseline").map((e) => e.intent);
    if (
      localIntents.some((i) => i === "workaround" || i === "experiment") &&
      baselineIntents.some((i) => i === "promoted" || i === "pattern")
    ) {
      contradictions.push({
        type: "SCOPE_CONTRADICTION",
        subtype: "LOCAL_BASELINE_INTENT_MISMATCH",
        message: "Local workaround/experiment may conflict with baseline promoted/pattern",
      });
    }
  }

  // Determine arbitration outcome (per canon/weighted-relevance-and-arbitration.md)
  // prefer | defer | escalate | propose_promotion
  //
  // KEY INSIGHT: If the only reason for low confidence is duplicate identity groups
  // (now collapsed), outcome should still be "prefer" with advisory + warnings.
  // Reserve "defer" for actual competing hypotheses (different docs, different claims).
  let arbitrationOutcome;
  const hasRealContradictions = contradictions.length > 0; // True conflicts, not hygiene warnings

  if (status === "INSUFFICIENT_EVIDENCE") {
    arbitrationOutcome = "defer";
  } else if (hasRealContradictions && !isConfident) {
    arbitrationOutcome = "escalate"; // True conflict + low confidence = need human
  } else if (hasRealContradictions && isConfident) {
    arbitrationOutcome = "propose_promotion"; // Repeated pattern = promotion candidate
  } else if (isConfident) {
    arbitrationOutcome = "prefer"; // Confident, no conflicts
  } else {
    // Not confident, but no real contradictions
    // This could be due to:
    // 1. Close scores after dedup (genuine uncertainty)
    // 2. Weak evidence/intent quality
    // Don't defer purely due to low confidence if we have evidence - prefer with advisory
    arbitrationOutcome = evidence.length >= MIN_EVIDENCE_BULLETS ? "prefer" : "defer";
  }

  // Build read_next
  const readNext = [];
  if (scored.length > 0) {
    const topDoc = scored[0].doc;
    const heading = findBestHeading(topDoc, queryTokens);
    if (heading) {
      readNext.push({
        path: formatCitation(topDoc, heading),
        reason: "Primary source",
      });
    }

    // Add a related doc if different
    if (scored.length > 1 && scored[1].doc.path !== topDoc.path) {
      const relatedHeading = findBestHeading(scored[1].doc, queryTokens);
      if (relatedHeading) {
        readNext.push({
          path: formatCitation(scored[1].doc, relatedHeading),
          reason: "Related context",
        });
      }
    }
  }

  // Determine policy intent
  const policyIntent = detectPolicyIntent(query);

  // Build rules fired (per canon/weighted-relevance-and-arbitration.md)
  const rulesFired = [];
  rulesFired.push("SUPPORTED_REQUIRES_EVIDENCE_BULLETS");
  rulesFired.push("QUOTE_LENGTH_ENFORCED");
  rulesFired.push("INTENT_GATED_PRECEDENCE"); // Always active as hard veto
  rulesFired.push("IDENTITY_DEDUP"); // Always active

  if (duplicateCount > 0) {
    rulesFired.push("INDEX_DUPLICATE_COLLAPSED");
  }

  if (status === "INSUFFICIENT_EVIDENCE") {
    rulesFired.push("INSUFFICIENT_EVIDENCE_RETURNED");
  }
  if (advisory) {
    rulesFired.push("LOW_CONFIDENCE_ADVISORY");
  }
  if (Object.keys(suppressed).length > 0) {
    rulesFired.push("SUPERSEDES_APPLIED");
  }
  if (precedenceViolations.length > 0) {
    rulesFired.push("INTENT_PRECEDENCE_VIOLATED");
  }
  if (vetoed.length > 0) {
    rulesFired.push("INTENT_PRECEDENCE_VETOED"); // Items were actually demoted
  }
  if (arbitrationOutcome === "escalate") {
    rulesFired.push("ESCALATION_REQUIRED");
  }
  if (arbitrationOutcome === "propose_promotion") {
    rulesFired.push("PROMOTION_CANDIDATE");
  }
  if (!baselineAvailable) {
    rulesFired.push("BASELINE_UNAVAILABLE");

    // INVARIANT: No evidence should have baseline origin when baseline unavailable
    const baselineEvidence = evidence.filter((e) => e.origin === "baseline");
    if (baselineEvidence.length > 0) {
      throw new Error(
        `Invariant violated: ${baselineEvidence.length} evidence items have origin:"baseline" while baseline is unavailable`,
      );
    }
  } else {
    rulesFired.push("BASELINE_LOADED");
  }
  if (policyIntent === "strong") {
    rulesFired.push("POLICY_INTENT_STRONG");
  } else if (policyIntent === "weak") {
    rulesFired.push("POLICY_INTENT_WEAK");
  } else {
    rulesFired.push("POLICY_INTENT_NONE");
  }

  const result = {
    status,
    advisory, // Separate from status to prevent "basically supported" laundering
    answer,
    confidence,
    confidence_factors: confidenceFactors, // Explainable components
    is_confident: isConfident,
    evidence,
    sources,
    read_next: readNext.slice(0, 2),
    // Arbitration data (per canon/weighted-relevance-and-arbitration.md section 2.3)
    arbitration: {
      outcome: arbitrationOutcome, // prefer | defer | escalate | propose_promotion
      candidates_considered: candidatesConsidered,
      contradictions, // Typed: AUTHORITY_, EVIDENCE_, SCOPE_, TEMPORAL_, STATE_
      warnings, // Hygiene warnings (INDEX_DUPLICATE, etc.) - not blocking
      precedence_violations: precedenceViolations,
      vetoed, // Items that were demoted by hard veto
      dedup: {
        collapsed_groups: collapsedGroups.length,
        duplicate_count: duplicateCount,
        groups: collapsedGroups,
      },
    },
    debug: {
      tool: "librarian",
      timestamp: new Date().toISOString(),
      repo_root: repoRoot,
      query,
      queryTokens,
      baseline_ref: baselineRef,
      baseline_ref_source: baseline.refSource,
      baseline_commit: baseline.commitSha || null,
      baseline_available: baselineAvailable,
      baseline_cache_used: !indexRebuildReason,
      index_rebuild_reason: indexRebuildReason,
      docs_considered: scored.length,
      evidence_accepted_count: evidenceAcceptedCount,
      evidence_rejected_count: evidenceRejectedCount,
      evidence_rejected_reasons: evidenceRejectedReasons,
      policy_intent: policyIntent,
      suppressed: Object.keys(suppressed).length > 0 ? suppressed : {},
      rules_fired: rulesFired,
      // Reference to governing doctrine
      governing_canon: "canon/weighted-relevance-and-arbitration.md",
      notes: [],
    },
  };

  // Write to last.json
  writeLast(result);

  return result;
}
