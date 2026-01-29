import { buildIndex, loadIndex, saveIndex } from "../index/buildIndex.js";
import { ensureBaselineRepo, getBaselineRef } from "../baseline/ensureBaselineRepo.js";
import { applySupersedes } from "../resolve/applySupersedes.js";
import { tokenize, scoreDocument, findBestHeading } from "../utils/scoring.js";
import { extractQuote, formatCitation, MIN_QUOTE_WORDS, countWords } from "../utils/slicing.js";
import { writeLast } from "../state/last.js";

const MIN_EVIDENCE_BULLETS = 2;
const MAX_RESULTS = 5;

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

  // Score all documents
  const scored = docs
    .map((doc) => ({
      doc,
      score: scoreDocument(doc, queryTokens),
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS);

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

  // Determine status
  const status = evidence.length >= MIN_EVIDENCE_BULLETS ? "SUPPORTED" : "INSUFFICIENT_EVIDENCE";

  // Build answer
  let answer;
  if (status === "SUPPORTED") {
    answer = `Found ${evidence.length} relevant document(s) for: "${query}"`;
  } else {
    answer = `Could not find sufficient evidence to answer: "${query}". Found ${evidence.length} partial match(es).`;
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

  // Build rules fired
  const rulesFired = [];
  rulesFired.push("SUPPORTED_REQUIRES_EVIDENCE_BULLETS");
  rulesFired.push("QUOTE_LENGTH_ENFORCED");

  if (status === "INSUFFICIENT_EVIDENCE") {
    rulesFired.push("INSUFFICIENT_EVIDENCE_RETURNED");
  }
  if (Object.keys(suppressed).length > 0) {
    rulesFired.push("SUPERSEDES_APPLIED");
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
    evidence,
    sources,
    read_next: readNext.slice(0, 2),
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
      notes: [],
    },
  };

  // Write to last.json
  writeLast(result);

  return result;
}
