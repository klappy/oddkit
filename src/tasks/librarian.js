import { buildIndex, loadIndex, saveIndex, INTENT_HIERARCHY } from "../index/buildIndex.js";
import { ensureBaselineRepo, getBaselineRef } from "../baseline/ensureBaselineRepo.js";
import { applySupersedes } from "../resolve/applySupersedes.js";
import { tokenize, scoreDocument, findBestHeading } from "../utils/scoring.js";
import { extractQuote, formatCitation, MIN_QUOTE_WORDS, countWords } from "../utils/slicing.js";
import { writeLast } from "../state/last.js";

const MIN_EVIDENCE_BULLETS = 2;
const MAX_RESULTS = 5;
const MIN_CONFIDENCE_THRESHOLD = 0.6; // Below this, result is advisory
const EXCESSIVE_DUPLICATE_THRESHOLD = 0.25; // >25% duplicates is a smell

/**
 * Compute drift volatility between two content versions
 * Returns: low | medium | high
 *
 * IMPORTANT: This is SIZE-BASED volatility, NOT semantic change.
 * A 30% char change could be a big example block (low semantic)
 * or a single MUST → MUST NOT (high semantic, tiny char change).
 *
 * Use NORMATIVE_DRIFT for semantic change detection.
 */
function computeDriftVolatility(localDoc, baselineDoc) {
  const localLen = localDoc?.contentLength || 0;
  const baselineLen = baselineDoc?.contentLength || 0;

  if (localLen === 0 || baselineLen === 0) {
    return "high"; // One is missing/empty = high volatility
  }

  // Compute relative difference
  const diff = Math.abs(localLen - baselineLen);
  const avgLen = (localLen + baselineLen) / 2;
  const ratio = diff / avgLen;

  if (ratio < 0.1) return "low"; // <10% change
  if (ratio < 0.3) return "medium"; // 10-30% change
  return "high"; // >30% change
}

/**
 * Normative tokens that carry policy weight
 * Changes in these tokens indicate potential rule changes, not just edits
 */
const NORMATIVE_TOKENS = {
  positive: ["MUST", "REQUIRED", "SHALL", "ALWAYS", "MANDATORY"],
  negative: ["MUST NOT", "MUST NEVER", "SHALL NOT", "NEVER", "FORBIDDEN", "PROHIBITED"],
  conditional: ["SHOULD", "SHOULD NOT", "MAY", "OPTIONAL", "RECOMMENDED"],
};

/**
 * Count normative tokens in content
 */
function countNormativeTokens(content) {
  if (!content) return { positive: 0, negative: 0, conditional: 0 };

  const upper = content.toUpperCase();
  return {
    positive: NORMATIVE_TOKENS.positive.reduce((sum, t) => sum + (upper.split(t).length - 1), 0),
    negative: NORMATIVE_TOKENS.negative.reduce((sum, t) => sum + (upper.split(t).length - 1), 0),
    conditional: NORMATIVE_TOKENS.conditional.reduce(
      (sum, t) => sum + (upper.split(t).length - 1),
      0,
    ),
  };
}

/**
 * Detect normative drift between two content versions
 * Returns: { hasNormativeDrift, polarityFlip, details }
 *
 * This catches "MUST → MUST NOT" changes that char-delta misses.
 * A polarity flip (positive→negative or vice versa) is HIGH severity.
 */
function detectNormativeDrift(localDoc, baselineDoc) {
  const localContent = localDoc?.contentPreview || "";
  const baselineContent = baselineDoc?.contentPreview || "";

  const localCounts = countNormativeTokens(localContent);
  const baselineCounts = countNormativeTokens(baselineContent);

  // Check for polarity flip: was positive-heavy, now negative-heavy (or vice versa)
  const localPolarity = localCounts.positive - localCounts.negative;
  const baselinePolarity = baselineCounts.positive - baselineCounts.negative;
  const polarityFlip =
    (localPolarity > 0 && baselinePolarity < 0) || (localPolarity < 0 && baselinePolarity > 0);

  // Check for material change in normative token counts
  const totalLocalNormative = localCounts.positive + localCounts.negative + localCounts.conditional;
  const totalBaselineNormative =
    baselineCounts.positive + baselineCounts.negative + baselineCounts.conditional;
  const normativeCountChange = Math.abs(totalLocalNormative - totalBaselineNormative);

  // Normative drift if: polarity flip OR significant count change
  const hasNormativeDrift = polarityFlip || normativeCountChange >= 2;

  return {
    hasNormativeDrift,
    polarityFlip,
    details: {
      local: localCounts,
      baseline: baselineCounts,
      countChange: normativeCountChange,
    },
  };
}

/**
 * Compute candidate identity key for dedup
 *
 * Identity key rules (per user critique: path-only is unsafe across repos):
 * - If URI exists: id = uri (URI is TRUE identity)
 * - Else: id = path + "::" + content_hash (path is heuristic, hash confirms)
 *
 * This prevents collision across repos where same path has different content.
 */
function computeIdentityKey(doc) {
  // 1. If uri exists, use it (stable across origins, TRUE identity)
  if (doc.uri) {
    return { key: doc.uri, type: "uri" };
  }
  // 2. Else use path + content_hash (path is heuristic, hash confirms identity)
  const hash = doc.content_hash || "no-hash";
  return { key: `${doc.path}::${hash}`, type: "path+hash" };
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
 * SAFETY FEATURES (per user critique):
 * - Non-URI dedup requires content_hash match (path-only is heuristic)
 * - URI collision with content mismatch emits IDENTITY_COLLISION warning
 * - Excessive duplicates (>25%) emits EXCESSIVE_DUPLICATES warning
 *
 * This is not "forced convergence" — it's treating duplicates as duplicates.
 * Per canon/weighted-relevance-and-arbitration.md: this removes artifact ambiguity
 * so "conflict" means real disagreement, not index hygiene.
 */
function deduplicateCandidates(docs) {
  const groups = new Map(); // key -> { docs[], idType }
  const collisions = []; // TRUE collisions: same URI, same origin, different content
  const drifts = []; // Expected drift: same URI, different origins, different content

  // Group by identity key
  for (const doc of docs) {
    const { key, type } = computeIdentityKey(doc);
    if (!groups.has(key)) {
      groups.set(key, { docs: [], idType: type });
    }
    groups.get(key).docs.push(doc);
  }

  const deduplicated = [];
  const collapsedGroups = [];

  for (const [key, { docs: groupDocs, idType }] of groups) {
    if (groupDocs.length === 1) {
      // No duplicates, keep as-is
      deduplicated.push(groupDocs[0]);
    } else {
      // Multiple docs with same identity key

      // For URI-based identity, distinguish DRIFT from COLLISION
      // DRIFT: same URI, different origins, different content (expected evolution)
      // COLLISION: same URI, SAME origin, different content (metadata error)
      if (idType === "uri") {
        const hashes = [...new Set(groupDocs.map((d) => d.content_hash || "no-hash"))];
        const origins = [...new Set(groupDocs.map((d) => d.origin))];

        if (hashes.length > 1) {
          // Content differs - is this drift or collision?
          if (origins.length > 1) {
            // Different origins (local vs baseline) = DRIFT (expected, not an error)
            const localDoc = groupDocs.find((d) => d.origin === "local");
            const baselineDoc = groupDocs.find((d) => d.origin === "baseline");
            const volatility = computeDriftVolatility(localDoc, baselineDoc);
            const normative = detectNormativeDrift(localDoc, baselineDoc);
            const isGoverning =
              localDoc?.authority_band === "governing" ||
              baselineDoc?.authority_band === "governing";

            drifts.push({
              uri: key,
              local: localDoc
                ? {
                    path: localDoc.path,
                    hash: localDoc.content_hash,
                    length: localDoc.contentLength,
                  }
                : null,
              baseline: baselineDoc
                ? {
                    path: baselineDoc.path,
                    hash: baselineDoc.content_hash,
                    length: baselineDoc.contentLength,
                  }
                : null,
              volatility, // low | medium | high (size-based, NOT semantic)
              normativeDrift: normative.hasNormativeDrift,
              polarityFlip: normative.polarityFlip,
              isGoverning,
              message: normative.polarityFlip
                ? `URI '${key}' has POLARITY FLIP — normative change detected`
                : normative.hasNormativeDrift
                  ? `URI '${key}' has normative drift (rule language changed)`
                  : `URI '${key}' has ${volatility} volatility drift`,
            });
          } else {
            // SAME origin but different content = TRUE COLLISION (metadata error)
            collisions.push({
              uri: key,
              origin: origins[0],
              paths: groupDocs.map((d) => ({
                path: d.path,
                hash: d.content_hash,
              })),
              message: `URI '${key}' has ${groupDocs.length} different docs in ${origins[0]} (metadata error)`,
            });
          }
        }
      }

      // Pick representative using tie-breaker
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
        id: key,
        idType,
        chosen: { origin: chosen.origin, path: chosen.path, hash: chosen.content_hash },
        collapsed: collapsed.map((d) => ({
          origin: d.origin,
          path: d.path,
          hash: d.content_hash,
        })),
      });
    }
  }

  const duplicateCount = docs.length - deduplicated.length;
  const duplicateRatio = docs.length > 0 ? duplicateCount / docs.length : 0;

  return {
    docs: deduplicated,
    collapsedGroups,
    duplicateCount,
    duplicateRatio,
    collisions, // TRUE collisions: same URI, same origin, different content (metadata error)
    drifts, // Expected drift: same URI, different origins, different content (normal)
    isExcessive: duplicateRatio > EXCESSIVE_DUPLICATE_THRESHOLD,
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
  const {
    docs,
    collapsedGroups,
    duplicateCount,
    duplicateRatio,
    collisions: uriCollisions, // TRUE collisions: same origin, different content (error)
    drifts: uriDrifts, // Expected drift: different origins, different content (normal)
    isExcessive: isExcessiveDuplicates,
  } = deduplicateCandidates(afterSupersedes);

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
  // Also true if URI collision exists (cannot trust result when identity is broken)
  const advisory = !isConfident || uriCollisions.length > 0;

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

  // URI_COLLISION: Same URI, SAME origin, different content (metadata error - high severity)
  // This is a TRUE collision that must be fixed - escalation is REQUIRED
  if (uriCollisions.length > 0) {
    for (const collision of uriCollisions) {
      warnings.push({
        type: "URI_COLLISION",
        uri: collision.uri,
        origin: collision.origin,
        paths: collision.paths,
        message: collision.message,
        severity: "high", // Metadata error, requires fix
        required_action:
          "Fix duplicate URI: choose one canonical path, change one URI, or add explicit supersedes",
        blocks_prefer: true, // Cannot "prefer" when identity is broken
      });
    }
  }

  // URI_DRIFT: Same URI, DIFFERENT origins, different content (expected evolution)
  // Volatility is SIZE-BASED (low/medium/high), not semantic
  // NORMATIVE_DRIFT is SEMANTIC (MUST/MUST NOT changes)
  if (uriDrifts.length > 0) {
    // Separate normative drifts (semantic) from volatility-only drifts (size)
    const normativeDrifts = uriDrifts.filter((d) => d.normativeDrift);
    const polarityFlips = normativeDrifts.filter((d) => d.polarityFlip);
    const governingNormative = normativeDrifts.filter((d) => d.isGoverning);
    const highVolatility = uriDrifts.filter((d) => d.volatility === "high");

    // NORMATIVE_DRIFT warnings (semantic changes) - higher severity
    if (normativeDrifts.length > 0) {
      let normativeSeverity = "medium";
      if (polarityFlips.length > 0) {
        normativeSeverity = "high"; // Polarity flip = rule inversion
      } else if (governingNormative.length > 0) {
        normativeSeverity = "high"; // Governing + normative = critical
      }

      warnings.push({
        type: "NORMATIVE_DRIFT",
        count: normativeDrifts.length,
        polarity_flips: polarityFlips.length,
        governing_count: governingNormative.length,
        drifts: normativeDrifts.slice(0, 5),
        message:
          polarityFlips.length > 0
            ? `${polarityFlips.length} URI(s) have POLARITY FLIP — rule direction changed`
            : `${normativeDrifts.length} URI(s) have normative drift (MUST/SHOULD language changed)`,
        severity: normativeSeverity,
      });
    }

    // URI_DRIFT warnings (volatility-based, size changes)
    // Severity: low for volatility-only, since it's not semantic
    warnings.push({
      type: "URI_DRIFT",
      count: uriDrifts.length,
      drifts: uriDrifts.slice(0, 10), // Limit for readability
      total_drifts: uriDrifts.length,
      by_volatility: {
        low: uriDrifts.filter((d) => d.volatility === "low").length,
        medium: uriDrifts.filter((d) => d.volatility === "medium").length,
        high: highVolatility.length,
      },
      normative_drifts: normativeDrifts.length,
      message: `${uriDrifts.length} URI(s) have version drift (volatility: ${highVolatility.length} high, ${normativeDrifts.length} normative)`,
      severity: "low", // Volatility alone is informational
      note: "Volatility is size-based, not semantic. See NORMATIVE_DRIFT for rule changes.",
    });
  }

  // EXCESSIVE_DUPLICATES: >25% of candidates were duplicates (unhealthy overlap)
  if (isExcessiveDuplicates) {
    warnings.push({
      type: "EXCESSIVE_DUPLICATES",
      count: duplicateCount,
      ratio: Math.round(duplicateRatio * 100),
      message: `${duplicateCount} duplicates (${Math.round(duplicateRatio * 100)}% of candidates). Baseline and local overlap heavily; consider pinning baseline ref or reducing baseline scope.`,
      threshold: Math.round(EXCESSIVE_DUPLICATE_THRESHOLD * 100),
    });
  }

  // INDEX_DUPLICATE: Standard dedup happened (informational)
  if (collapsedGroups.length > 0) {
    warnings.push({
      type: "INDEX_DUPLICATE",
      count: duplicateCount,
      ratio: Math.round(duplicateRatio * 100),
      message: `${duplicateCount} duplicate(s) collapsed from ${collapsedGroups.length} identity group(s).`,
      groups: collapsedGroups.slice(0, 10), // Limit to first 10 for readability
      total_groups: collapsedGroups.length,
    });
  }

  // MISSING_URI_FOR_POLICY_DOC: Policy docs should have URI for stable identity
  // More precise than just "governing folder" - check actual policy signals:
  // - authority_band: governing
  // - intent: promoted or pattern (durable intents need stable identity)
  // - evidence: strong or medium (evidence-backed docs need tracking)
  const isPolicyDoc = (d) => {
    if (d.uri) return false; // Already has URI
    if (d.origin !== "local") return false; // Only warn for local docs
    // Check policy signals
    if (d.authority_band === "governing") return true;
    if (d.intent === "promoted" || d.intent === "pattern") return true;
    if (d.evidence === "strong" || d.evidence === "medium") return true;
    return false;
  };
  const policyDocsWithoutUri = docs.filter(isPolicyDoc);
  if (policyDocsWithoutUri.length > 0) {
    warnings.push({
      type: "MISSING_URI_FOR_POLICY_DOC",
      count: policyDocsWithoutUri.length,
      paths: policyDocsWithoutUri.slice(0, 5).map((d) => d.path),
      total: policyDocsWithoutUri.length,
      message: `${policyDocsWithoutUri.length} policy doc(s) lack URI. Add uri frontmatter to stabilize identity.`,
      severity: "medium", // Smell, not error
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
  const hasUriCollision = uriCollisions.length > 0; // Metadata error = must escalate

  if (hasUriCollision) {
    // URI_COLLISION is a metadata error that MUST be escalated
    // Cannot confidently prefer when identity is broken
    arbitrationOutcome = "escalate";
  } else if (status === "INSUFFICIENT_EVIDENCE") {
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
  if (isExcessiveDuplicates) {
    rulesFired.push("EXCESSIVE_DUPLICATES");
  }
  if (uriCollisions.length > 0) {
    rulesFired.push("URI_COLLISION_DETECTED"); // TRUE collision: same origin, different content
  }
  if (uriDrifts.length > 0) {
    rulesFired.push("URI_DRIFT_DETECTED"); // Expected drift: different origins (normal)
    const normativeDrifts = uriDrifts.filter((d) => d.normativeDrift);
    if (normativeDrifts.length > 0) {
      rulesFired.push("NORMATIVE_DRIFT_DETECTED"); // Semantic change: MUST/SHOULD language
      const polarityFlips = normativeDrifts.filter((d) => d.polarityFlip);
      if (polarityFlips.length > 0) {
        rulesFired.push("POLARITY_FLIP_DETECTED"); // Critical: rule direction changed
      }
    }
  }
  if (policyDocsWithoutUri.length > 0) {
    rulesFired.push("MISSING_URI_FOR_POLICY_DOC"); // Policy docs need stable identity
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
