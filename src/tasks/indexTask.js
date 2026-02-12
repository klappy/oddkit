import { buildIndex, saveIndex, saveBaselineIndex } from "../index/buildIndex.js";
import { ensureBaselineRepo, getBaselineRef } from "../baseline/ensureBaselineRepo.js";

/**
 * Run the index command
 */
export async function runIndex(options) {
  const repoRoot = options.repo;

  // Get baseline (CLI flag overrides env var overrides default)
  const baseline = await ensureBaselineRepo(options.baseline);
  const baselineRef = getBaselineRef();

  // Build index
  const index = await buildIndex(repoRoot, baseline.root);

  // Save local index
  const localIndexPath = saveIndex(index, repoRoot);

  // Save baseline index if available
  let baselineIndexPath = null;
  if (baseline.root) {
    baselineIndexPath = saveBaselineIndex(index, baselineRef, baseline.commitSha);
  }

  return {
    success: true,
    localIndexPath,
    baselineIndexPath,
    stats: index.stats,
    baseline: {
      available: !!baseline.root,
      url: baseline.baselineUrl,
      source: baseline.baselineSource, // cli | environment | default
      ref: baselineRef,
      refSource: baseline.refSource,
      commit: baseline.commitSha || null,
      error: baseline.error,
    },
  };
}
