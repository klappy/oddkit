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
 * Apply intent-gated precedence (per canon/weighted-relevance-and-arbitration.md)
 * A newer workaround/experiment MUST NOT outrank an older promoted/pattern
 * unless it explicitly supersedes it
 */
function applyIntentGatedPrecedence(candidates, supersededUris) {
  const violations = [];

  // Find the highest-intent item
  const maxIntent = Math.max(...candidates.map((c) => INTENT_HIERARCHY[c.doc.intent] || 3));

  // Check for violations: low-intent items ranked above high-intent items
  for (let i = 0; i < candidates.length; i++) {
    const current = candidates[i];
    const currentIntent = INTENT_HIERARCHY[current.doc.intent] || 3;

    // Low intent items (workaround, experiment) cannot outrank high intent (pattern, promoted)
    if (currentIntent <= 2) {
      // workaround or experiment
      const higherIntentBelow = candidates.slice(i + 1).find((c) => {
        const intent = INTENT_HIERARCHY[c.doc.intent] || 3;
        return intent >= 4; // pattern or promoted
      });

      if (higherIntentBelow) {
        // Check if current explicitly supersedes the higher-intent item
        const currentSupersedes = current.doc.supersedes;
        const higherUri = higherIntentBelow.doc.uri;

        if (!currentSupersedes || currentSupersedes !== higherUri) {
          violations.push({
            lowIntent: current.doc.path,
            lowIntentType: current.doc.intent,
            highIntent: higherIntentBelow.doc.path,
            highIntentType: higherIntentBelow.doc.intent,
          });
        }
      }
    }
  }

  return violations;
}

/**
 * Calculate confidence level based on evidence quality and consistency
 * Per canon/weighted-relevance-and-arbitration.md: low confidence = advisory
 */
function calculateConfidence(scored, evidence) {
  if (evidence.length === 0) return 0;
  if (scored.length === 0) return 0;

  // Factors that reduce confidence
  let confidence = 1.0;

  // Few evidence bullets
  if (evidence.length < MIN_EVIDENCE_BULLETS) {
    confidence *= 0.5;
  }

  // Weak evidence strength in sources
  const avgEvidence =
    scored.slice(0, evidence.length).reduce((sum, s) => {
      const evWeight = { none: 0.5, weak: 0.7, medium: 1.0, strong: 1.0 }[s.doc.evidence] || 0.8;
      return sum + evWeight;
    }, 0) / evidence.length;
  confidence *= avgEvidence;

  // Low-intent sources dominating
  const avgIntent =
    scored.slice(0, evidence.length).reduce((sum, s) => {
      const intWeight = INTENT_HIERARCHY[s.doc.intent] || 3;
      return sum + intWeight / 5;
    }, 0) / evidence.length;
  confidence *= avgIntent;

  return Math.min(1.0, Math.max(0, confidence));
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

  // Apply supersedes
  const { filtered: docs, suppressed } = applySupersedes(index.documents);

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

  // Check for intent-gated precedence violations (per canon/weighted-relevance-and-arbitration.md)
  const precedenceViolations = applyIntentGatedPrecedence(scored, suppressed);

  // Build candidates considered (for output contract 2.3)
  const candidatesConsidered = scored.map((s) => ({
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

  for (const { doc } of scored) {
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

  // Calculate confidence (per canon/weighted-relevance-and-arbitration.md)
  const confidence = calculateConfidence(scored, evidence);
  const isConfident = confidence >= MIN_CONFIDENCE_THRESHOLD;

  // Determine status
  let status;
  if (evidence.length >= MIN_EVIDENCE_BULLETS) {
    status = isConfident ? "SUPPORTED" : "SUPPORTED_ADVISORY";
  } else {
    status = "INSUFFICIENT_EVIDENCE";
  }

  // Build answer
  let answer;
  if (status === "SUPPORTED") {
    answer = `Found ${evidence.length} relevant document(s) for: "${query}"`;
  } else if (status === "SUPPORTED_ADVISORY") {
    answer = `Found ${evidence.length} relevant document(s) for: "${query}" (advisory: confidence is low)`;
  } else {
    answer = `Could not find sufficient evidence to answer: "${query}". Found ${evidence.length} partial match(es).`;
  }

  // Detect contradictions (per canon/weighted-relevance-and-arbitration.md: no silent resolution)
  const contradictions = [];
  if (precedenceViolations.length > 0) {
    for (const v of precedenceViolations) {
      contradictions.push({
        type: "INTENT_PRECEDENCE_VIOLATION",
        message: `${v.lowIntentType} (${v.lowIntent}) ranked above ${v.highIntentType} (${v.highIntent}) without explicit supersedes`,
      });
    }
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
  rulesFired.push("INTENT_GATED_PRECEDENCE"); // Always active

  if (status === "INSUFFICIENT_EVIDENCE") {
    rulesFired.push("INSUFFICIENT_EVIDENCE_RETURNED");
  }
  if (status === "SUPPORTED_ADVISORY") {
    rulesFired.push("LOW_CONFIDENCE_ADVISORY");
  }
  if (Object.keys(suppressed).length > 0) {
    rulesFired.push("SUPERSEDES_APPLIED");
  }
  if (precedenceViolations.length > 0) {
    rulesFired.push("INTENT_PRECEDENCE_VIOLATED");
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
    answer,
    confidence: Math.round(confidence * 100) / 100,
    is_confident: isConfident,
    evidence,
    sources,
    read_next: readNext.slice(0, 2),
    // Arbitration data (per canon/weighted-relevance-and-arbitration.md section 2.3)
    arbitration: {
      candidates_considered: candidatesConsidered,
      contradictions,
      precedence_violations: precedenceViolations,
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
