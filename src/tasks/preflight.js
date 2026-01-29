/**
 * Preflight task - returns relevant docs, constraints, DoD, and pitfalls
 * before implementation begins. No doc injection - just paths and 1-line summaries.
 *
 * Reuses catalog for start_here/next_up/canon_by_tag/playbooks.
 * Adds: constraints_docs, dod, pitfalls, suggested_questions.
 */

import { runCatalog } from "./catalog.js";
import { buildIndex, loadIndex, saveIndex } from "../index/buildIndex.js";
import { ensureBaselineRepo } from "../baseline/ensureBaselineRepo.js";
import { applySupersedes } from "../resolve/applySupersedes.js";
import { writeLast } from "../state/last.js";

const CONSTRAINTS_CAP = 5;
const PITFALLS_CAP = 5;

/**
 * Extract keywords from a message for matching
 */
function extractKeywords(message) {
  if (!message) return [];
  const lower = message.toLowerCase();
  // Common implementation targets
  const targets = [
    "mcp",
    "server",
    "orchestrate",
    "cli",
    "index",
    "catalog",
    "validate",
    "librarian",
    "preflight",
    "explain",
    "baseline",
    "tools",
    "prompts",
  ];
  return targets.filter((t) => lower.includes(t));
}

/**
 * Score a doc by keyword matches in title/subtitle/tags/path
 */
function scoreDocByKeywords(doc, keywords) {
  if (!keywords.length) return 0;
  let score = 0;
  const searchText = [doc.title || "", doc.subtitle || "", doc.path || "", ...(doc.tags || [])]
    .join(" ")
    .toLowerCase();

  for (const kw of keywords) {
    if (searchText.includes(kw)) score++;
  }
  return score;
}

/**
 * Find constraints docs relevant to the message
 */
function findConstraintsDocs(docs, keywords) {
  // Filter to governing band
  const governing = docs.filter((d) => d.authority_band === "governing");

  // Score by keyword relevance
  const scored = governing.map((d) => ({
    doc: d,
    score: scoreDocByKeywords(d, keywords),
  }));

  // Sort by score desc, then by path
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (a.doc.path || "").localeCompare(b.doc.path || "");
  });

  // Take top matches
  return scored
    .filter((s) => s.score > 0)
    .slice(0, CONSTRAINTS_CAP)
    .map((s) => ({
      path: s.doc.path,
      title: s.doc.title || null,
    }));
}

/**
 * Find Definition of Done doc
 */
function findDodDoc(docs) {
  const dodPatterns = [/definition-of-done/i, /dod\.md$/i, /\bdod\b/i];

  for (const pattern of dodPatterns) {
    const match = docs.find((d) => d.authority_band === "governing" && pattern.test(d.path || ""));
    if (match) {
      return { path: match.path, title: match.title || null };
    }
  }
  return null;
}

/**
 * Find pitfall/workaround docs
 */
function findPitfallDocs(docs, keywords) {
  const pitfallPatterns = [
    /pitfall/i,
    /gotcha/i,
    /workaround/i,
    /failure/i,
    /attempt/i,
    /smoke/i,
    /known.?issue/i,
  ];

  const candidates = docs.filter((d) => {
    const path = d.path || "";
    const intent = d.intent || "";

    // Match by intent
    if (intent === "workaround" || intent === "operational") return true;

    // Match by path patterns
    for (const pattern of pitfallPatterns) {
      if (pattern.test(path)) return true;
    }

    // Match by keywords in path
    for (const kw of keywords) {
      if (path.toLowerCase().includes(kw)) return true;
    }

    return false;
  });

  // Score by keyword relevance
  const scored = candidates.map((d) => ({
    doc: d,
    score: scoreDocByKeywords(d, keywords),
  }));

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (a.doc.path || "").localeCompare(b.doc.path || "");
  });

  return scored.slice(0, PITFALLS_CAP).map((s) => ({
    path: s.doc.path,
    title: s.doc.title || null,
  }));
}

/**
 * Run preflight task
 *
 * @param {Object} options
 * @param {string} options.repo - Repository root path
 * @param {string} options.baseline - Baseline override
 * @param {string} options.message - The preflight message (what the agent is about to do)
 * @returns {Promise<Object>}
 */
export async function runPreflight(options) {
  const { repo: repoRoot, baseline: baselineOverride, message } = options;

  // Reuse catalog to get start_here, next_up, canon_by_tag, playbooks
  const catalogResult = await runCatalog({
    repo: repoRoot,
    baseline: baselineOverride,
  });

  // Load index for additional queries (catalog already built/loaded it)
  const baseline = await ensureBaselineRepo(baselineOverride);
  const baselineAvailable = !!baseline.root;

  let index = loadIndex(repoRoot);
  if (!index) {
    index = await buildIndex(repoRoot, baselineAvailable ? baseline.root : null);
    saveIndex(index, repoRoot);
  }

  const { filtered: docs } = applySupersedes(index.documents);

  // Extract keywords from message for relevance matching
  const keywords = extractKeywords(message);

  // Find constraints, DoD, and pitfalls
  const constraintsDocs = findConstraintsDocs(docs, keywords);
  const dod = findDodDoc(docs);
  const pitfalls = findPitfallDocs(docs, keywords);

  const result = {
    status: "SUPPORTED",
    advisory: false,
    start_here: catalogResult.start_here,
    next_up: catalogResult.next_up,
    canon_by_tag: catalogResult.canon_by_tag,
    playbooks: catalogResult.playbooks,
    constraints_docs: constraintsDocs,
    dod,
    pitfalls,
    suggested_questions: [
      "What artifacts does validate require when I claim done?",
      "What constraints apply to this type of change?",
      "What is the Definition of Done?",
    ],
    debug: {
      tool: "preflight",
      reason: "PREFLIGHT_INTENT",
      timestamp: new Date().toISOString(),
      repo_root: repoRoot,
      keywords_extracted: keywords,
    },
  };

  writeLast(result);
  return result;
}
