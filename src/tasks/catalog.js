import { buildIndex, loadIndex, saveIndex, INTENT_HIERARCHY, INDEX_VERSION } from "../index/buildIndex.js";
import { ensureBaselineRepo, getBaselineRef } from "../baseline/ensureBaselineRepo.js";
import { applySupersedes } from "../resolve/applySupersedes.js";
import { writeLast } from "../state/last.js";

const START_TAGS = ["quickstart", "getting-started", "start"];
const TOP_TAGS_COUNT = 5;
const DOCS_PER_TAG = 3;
const PLAYBOOKS_CAP = 7;
const NEXT_UP_COUNT = 3;

/**
 * Run catalog task: build menu from index metadata (canon by tag, playbooks, start here, next up).
 * Reuses librarian's index pipeline: ensureBaselineRepo, load/build index, applySupersedes.
 * No scoring. No baseline changes.
 *
 * @param {Object} options
 * @param {string} options.repo - Repository root path
 * @param {string} options.baseline - Baseline override (CLI/env/default)
 * @returns {Promise<Object>} { status, advisory, start_here, next_up, canon_by_tag, playbooks, debug }
 */
export async function runCatalog(options) {
  const { repo: repoRoot, baseline: baselineOverride } = options;

  const baseline = await ensureBaselineRepo(baselineOverride);
  getBaselineRef();
  const baselineAvailable = !!baseline.root;

  let index = loadIndex(repoRoot);
  // Schema version gate: stale index shapes (e.g. missing start_here fields) silently
  // break newer features. A version mismatch forces a full rebuild.
  if (index && index.version !== INDEX_VERSION) {
    index = null;
  }
  if (index) {
    const hasBaselineDocs = index.documents.some((d) => d.origin === "baseline");
    if (!baselineAvailable && hasBaselineDocs) index = null;
    else if (baselineAvailable && !hasBaselineDocs) index = null;
  }
  if (!index) {
    index = await buildIndex(repoRoot, baselineAvailable ? baseline.root : null);
    saveIndex(index, repoRoot);
  }

  const { filtered: docs } = applySupersedes(index.documents);

  const canon = docs.filter(
    (d) => d.authority_band === "governing" && (d.intent === "promoted" || d.intent === "pattern"),
  );
  canon.sort((a, b) => {
    const ia = INTENT_HIERARCHY[a.intent] ?? 3;
    const ib = INTENT_HIERARCHY[b.intent] ?? 3;
    if (ib !== ia) return ib - ia;
    return (a.path || "").localeCompare(b.path || "");
  });

  const tagToDocs = new Map();
  for (const d of canon) {
    const tags = (d.tags || []).map((t) => String(t).toLowerCase().trim()).filter(Boolean);
    for (const tag of tags) {
      if (!tagToDocs.has(tag)) tagToDocs.set(tag, []);
      const arr = tagToDocs.get(tag);
      if (!arr.some((x) => x.path === d.path)) arr.push(d);
    }
  }
  const tagCounts = [...tagToDocs.entries()].map(([tag, arr]) => ({ tag, count: arr.length }));
  tagCounts.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.tag.localeCompare(b.tag);
  });
  const topTags = tagCounts.slice(0, TOP_TAGS_COUNT).map((t) => t.tag);

  const canonByTag = topTags.map((tag) => {
    const arr = tagToDocs.get(tag) || [];
    const ordered = [...arr].sort((a, b) => {
      const ia = INTENT_HIERARCHY[a.intent] ?? 3;
      const ib = INTENT_HIERARCHY[b.intent] ?? 3;
      if (ib !== ia) return ib - ia;
      return (a.path || "").localeCompare(b.path || "");
    });
    return {
      tag,
      docs: ordered.slice(0, DOCS_PER_TAG).map((d) => ({
        path: d.path,
        title: d.title ?? null,
        intent: d.intent,
      })),
    };
  });

  const playbookCandidates = docs.filter(
    (d) =>
      (d.path || "").startsWith("docs/") &&
      (d.authority_band === "operational" || d.intent === "operational"),
  );
  playbookCandidates.sort((a, b) => (a.path || "").localeCompare(b.path || ""));
  const playbooks = playbookCandidates.slice(0, PLAYBOOKS_CAP).map((d) => ({
    path: d.path,
    title: d.title ?? null,
  }));

  // Build start_here list from frontmatter (start_here: true, sorted by start_here_order)
  let startHereDocs = docs
    .filter((d) => d.start_here === true)
    .sort((a, b) => {
      const oa = a.start_here_order ?? Infinity;
      const ob = b.start_here_order ?? Infinity;
      if (oa !== ob) return oa - ob;
      return (a.path || "").localeCompare(b.path || "");
    });

  // Fallback when no docs have start_here frontmatter: match quickstart path/tags or first canon doc
  if (startHereDocs.length === 0) {
    const quickstartMatch = (d) => {
      if (!d.path) return false;
      const p = d.path.toLowerCase();
      if (p.includes("quickstart")) return true;
      const tags = (d.tags || []).map((t) => String(t).toLowerCase().trim());
      return START_TAGS.some((t) => tags.includes(t));
    };
    const fallbackDoc = docs.find(quickstartMatch) || (canon.length > 0 ? canon[0] : null);
    if (fallbackDoc) {
      startHereDocs = [fallbackDoc];
    }
  }

  const startHere = startHereDocs.map((d) => ({
    path: d.path,
    title: d.title ?? null,
    start_here_order: d.start_here_order ?? null,
    start_here_label: d.start_here_label ?? null,
  }));

  // next_up: items after the first in start_here, capped at NEXT_UP_COUNT
  const nextUp = startHere.slice(1, 1 + NEXT_UP_COUNT).map((d) => ({
    path: d.path,
    title: d.title ?? null,
  }));

  const result = {
    status: "SUPPORTED",
    advisory: false,
    start_here: startHere,
    next_up: nextUp,
    canon_by_tag: canonByTag,
    playbooks,
    debug: {
      tool: "catalog",
      reason: "CATALOG_INTENT",
      timestamp: new Date().toISOString(),
      repo_root: repoRoot,
    },
  };

  writeLast(result);
  return result;
}
