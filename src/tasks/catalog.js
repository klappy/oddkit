import { buildIndex, loadIndex, saveIndex, INTENT_HIERARCHY } from "../index/buildIndex.js";
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

  const quickstartMatch = (d) => {
    if (!d.path) return false;
    const p = d.path.toLowerCase();
    if (p.includes("quickstart")) return true;
    const tags = (d.tags || []).map((t) => String(t).toLowerCase().trim());
    return START_TAGS.some((t) => tags.includes(t));
  };

  let startHere = null;
  const startCandidate = docs.find(quickstartMatch);
  if (startCandidate) {
    startHere = { path: startCandidate.path, title: startCandidate.title ?? null };
  } else if (canon.length > 0) {
    const first = canon[0];
    startHere = { path: first.path, title: first.title ?? null };
  }

  const nextUp = [];
  if (startHere) {
    const canonPaths = canon.map((d) => d.path);
    const idx = canonPaths.indexOf(startHere.path);
    const after = idx < 0 ? canon : canon.slice(idx + 1);
    for (const d of after) {
      if (nextUp.length >= NEXT_UP_COUNT) break;
      nextUp.push({ path: d.path, title: d.title ?? null });
    }
    const used = new Set([startHere.path, ...nextUp.map((x) => x.path)]);
    for (const p of playbooks) {
      if (nextUp.length >= NEXT_UP_COUNT) break;
      if (!used.has(p.path)) {
        used.add(p.path);
        nextUp.push(p);
      }
    }
  }

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
