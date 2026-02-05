/**
 * Efficient change detection for canon repos.
 *
 * Uses lightweight network calls to check if a repo has changed:
 * - git ls-remote: Fetches only refs (~100 bytes) instead of full fetch
 * - GitHub API: Returns just commit SHA when using Accept header
 *
 * This allows checking for changes without downloading repo content,
 * saving bandwidth and time when the source hasn't changed.
 */

import { checkRemoteForChanges, getCacheDir, getBaselineRef, resolveBaselineSource } from "./ensureBaselineRepo.js";
import { existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

/**
 * Check if a baseline repo has changes without fetching content.
 *
 * @param {string|null} cliOverride - CLI --baseline override
 * @returns {Promise<{
 *   changed: boolean,
 *   currentSha: string|null,
 *   cachedSha: string|null,
 *   repoUrl: string,
 *   ref: string,
 *   error: string|null
 * }>}
 */
export async function checkBaselineForChanges(cliOverride = null) {
  const { url: baselineUrl } = resolveBaselineSource(cliOverride);
  const ref = getBaselineRef();

  // For local paths, check git status
  if (baselineUrl.startsWith("/") || baselineUrl.startsWith("~") || baselineUrl.startsWith("./")) {
    return {
      changed: false, // Local paths don't have remote changes
      currentSha: null,
      cachedSha: null,
      repoUrl: baselineUrl,
      ref: "local",
      error: null,
    };
  }

  // Get cached SHA from local clone
  const cacheDir = getCacheDir(baselineUrl, ref);
  let cachedSha = null;

  if (existsSync(join(cacheDir, ".git"))) {
    try {
      cachedSha = execSync("git rev-parse HEAD", { cwd: cacheDir, stdio: "pipe" })
        .toString()
        .trim();
    } catch {
      // Couldn't get cached SHA
    }
  }

  // Check remote for changes using lightweight ls-remote
  const result = checkRemoteForChanges(baselineUrl, ref, cachedSha);

  return {
    ...result,
    repoUrl: baselineUrl,
    ref,
  };
}

/**
 * Check multiple repos for changes in parallel.
 *
 * @param {Array<{url: string, ref?: string, cachedSha?: string}>} repos
 * @returns {Promise<Array<{url: string, changed: boolean, currentSha: string|null, error: string|null}>>}
 */
export async function checkMultipleReposForChanges(repos) {
  const results = repos.map(({ url, ref = "main", cachedSha = null }) => {
    const result = checkRemoteForChanges(url, ref, cachedSha);
    return {
      url,
      ...result,
    };
  });

  return results;
}

/**
 * Summary of change check for display.
 *
 * @param {Object} result - Result from checkBaselineForChanges
 * @returns {string} Human-readable summary
 */
export function formatChangeCheckResult(result) {
  if (result.error) {
    return `⚠️  Could not check ${result.repoUrl}: ${result.error}`;
  }

  if (result.changed) {
    if (result.cachedSha && result.currentSha) {
      return `🔄 Changes detected in ${result.repoUrl}\n   Local:  ${result.cachedSha.slice(0, 7)}\n   Remote: ${result.currentSha.slice(0, 7)}`;
    }
    return `🔄 Changes detected in ${result.repoUrl} (no local cache)`;
  }

  return `✓  No changes in ${result.repoUrl} (${result.currentSha?.slice(0, 7) || "unknown"})`;
}
