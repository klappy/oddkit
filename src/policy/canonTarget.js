/**
 * canonTarget.js
 *
 * Resolves the authoritative canon target for oddkit.
 * This determines what commit/version of canon is authoritative right now.
 *
 * Resolution order:
 *   1. ODDKIT_BASELINE_REF env (pinned commit/tag)
 *   2. Git HEAD of the baseline checkout
 *   3. Bundled snapshot metadata (if packaged)
 *
 * Returns a CanonTarget object describing mode, commit, and source.
 */

import { ensureBaselineRepo } from "../baseline/ensureBaselineRepo.js";

/**
 * @typedef {Object} CanonTarget
 * @property {"pinned" | "head" | "bundled" | "local" | "unknown"} mode
 * @property {string | null} commit - Short or full commit SHA
 * @property {string | null} tag - Tag name if pinned to a tag
 * @property {"env" | "config" | "repo" | "bundle" | "local"} source - Where the target was determined from
 * @property {string | null} baselineUrl - The baseline URL or path
 * @property {string | null} error - Error message if resolution failed
 */

/**
 * Resolve the authoritative canon target.
 *
 * @param {string | null} baselineOverride - CLI override for baseline
 * @returns {Promise<CanonTarget>}
 */
export async function resolveCanonTarget(baselineOverride = null) {
  try {
    const baseline = await ensureBaselineRepo(baselineOverride);

    if (baseline.error) {
      return {
        mode: "unknown",
        commit: null,
        tag: null,
        source: "repo",
        baselineUrl: baseline.baselineUrl,
        error: baseline.error,
      };
    }

    // Determine mode based on how the baseline was resolved
    let mode = "head";
    let tag = null;
    const source = baseline.baselineSource === "environment" ? "env" : baseline.baselineSource;

    // Check if we're pinned to a specific ref via environment
    if (process.env.ODDKIT_BASELINE_REF) {
      const ref = process.env.ODDKIT_BASELINE_REF;
      // If ref looks like a tag (v1.0.0, etc.), mark as pinned
      if (/^v?\d/.test(ref) || (ref !== "main" && ref !== "master")) {
        mode = "pinned";
        tag = ref;
      }
    }

    // Local paths are a special mode
    if (baseline.refSource === "local") {
      mode = "local";
    }

    // Short commit (first 7 chars)
    const shortCommit = baseline.commitSha ? baseline.commitSha.slice(0, 7) : null;

    return {
      mode,
      commit: shortCommit,
      commitFull: baseline.commitSha,
      tag,
      source,
      baselineUrl: baseline.baselineUrl,
      ref: baseline.ref,
      error: null,
    };
  } catch (err) {
    return {
      mode: "unknown",
      commit: null,
      tag: null,
      source: "repo",
      baselineUrl: null,
      error: err.message || "Failed to resolve canon target",
    };
  }
}

/**
 * Get a short summary of the canon target for display.
 *
 * @param {CanonTarget} target
 * @returns {string}
 */
export function formatCanonTarget(target) {
  if (target.error) {
    return `unknown (${target.error})`;
  }
  if (target.tag) {
    return `${target.tag} (${target.commit})`;
  }
  return `${target.mode}:${target.commit}`;
}
