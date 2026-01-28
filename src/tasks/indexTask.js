import { buildIndex, saveIndex, saveBaselineIndex } from "../index/buildIndex.js";
import { ensureBaselineRepo, getBaselineRef } from "../baseline/ensureBaselineRepo.js";

/**
 * Run the index command
 */
export async function runIndex(options) {
  const repoRoot = options.repo;

  // Get baseline
  const baseline = await ensureBaselineRepo();
  const baselineRef = getBaselineRef();

  // Build index
  const index = await buildIndex(repoRoot, baseline.root);

  // Save local index
  const localIndexPath = saveIndex(index, repoRoot);

  // Save baseline index if available
  let baselineIndexPath = null;
  if (baseline.root) {
    baselineIndexPath = saveBaselineIndex(index, baselineRef);
  }

  return {
    success: true,
    localIndexPath,
    baselineIndexPath,
    stats: index.stats,
    baseline: {
      available: !!baseline.root,
      ref: baselineRef,
      refSource: baseline.refSource,
      error: baseline.error,
    },
  };
}
