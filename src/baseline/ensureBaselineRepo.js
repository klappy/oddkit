import { execSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "fs";
import { join, resolve, isAbsolute } from "path";
import { homedir } from "os";

const DEFAULT_BASELINE_URL = "https://github.com/klappy/klappy.dev.git";
const DEFAULT_REF = "main";

// ──────────────────────────────────────────────────────────────────────────────
// Per-session SHA resolution cache
//
// Within a single process lifetime, the resolved remote SHA is cached so that
// multiple calls to ensureBaselineRepo (search, get, catalog, etc.) within one
// request do not each hit the network. This is NOT a TTL cache — it is scoped
// to the current process invocation. A new process always re-resolves.
// ──────────────────────────────────────────────────────────────────────────────
let sessionResolvedSha = null;
let sessionResolvedKey = null; // "url|ref" to detect parameter changes

/**
 * Reset the per-session SHA cache. Exported for testing.
 */
export function resetSessionShaCache() {
  sessionResolvedSha = null;
  sessionResolvedKey = null;
}

/**
 * Get the current session-resolved SHA (if any). Exported for observability.
 */
export function getSessionSha() {
  return sessionResolvedSha;
}

/**
 * Check for changes in remote repo without fetching content.
 * Uses `git ls-remote` which only fetches refs (~100 bytes).
 *
 * @param {string} repoUrl - Git repository URL
 * @param {string} ref - Branch/tag to check (default: "main")
 * @param {string|null} cachedSha - Previously cached commit SHA
 * @returns {{ changed: boolean, currentSha: string|null, cachedSha: string|null, error: string|null }}
 */
export function checkRemoteForChanges(repoUrl, ref = "main", cachedSha = null) {
  try {
    // git ls-remote is lightweight - only fetches refs, not objects
    const output = execSync(`git ls-remote ${repoUrl} refs/heads/${ref}`, {
      stdio: "pipe",
      timeout: 10000, // 10 second timeout
    })
      .toString()
      .trim();

    // Output format: "<sha>\trefs/heads/<ref>"
    const currentSha = output.split("\t")[0];

    if (!currentSha) {
      return { changed: true, currentSha: null, cachedSha, error: "Could not parse remote SHA" };
    }

    if (!cachedSha) {
      // No cached SHA to compare against
      return { changed: true, currentSha, cachedSha: null, error: null };
    }

    const changed = currentSha !== cachedSha;
    return { changed, currentSha, cachedSha, error: null };
  } catch (err) {
    return { changed: true, currentSha: null, cachedSha, error: err.message };
  }
}

/**
 * Check if a string looks like a git URL
 */
function isGitUrl(str) {
  return (
    str.startsWith("https://") ||
    str.startsWith("git@") ||
    str.startsWith("git://") ||
    str.startsWith("ssh://")
  );
}

/**
 * Check if a string is a local path (absolute or relative)
 */
function isLocalPath(str) {
  return (
    str.startsWith("/") || str.startsWith("./") || str.startsWith("../") || str.startsWith("~")
  );
}

/**
 * Resolve the baseline source: CLI flag > env var > default
 * Returns { url, source } where source is "cli" | "environment" | "default"
 */
export function resolveBaselineSource(cliOverride = null) {
  if (cliOverride) {
    return { url: cliOverride, source: "cli" };
  }
  if (process.env.ODDKIT_BASELINE) {
    return { url: process.env.ODDKIT_BASELINE, source: "environment" };
  }
  return { url: DEFAULT_BASELINE_URL, source: "default" };
}

/**
 * Get the baseline ref from environment or default
 */
export function getBaselineRef() {
  return process.env.ODDKIT_BASELINE_REF || DEFAULT_REF;
}

/**
 * Get a safe cache directory name from a URL or path
 */
function getCacheName(url) {
  // Extract repo name from URL or use sanitized path
  const match = url.match(/\/([^\/]+?)(\.git)?$/);
  if (match) {
    return match[1];
  }
  // Fallback: sanitize the whole thing
  return url.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50);
}

/**
 * Get the cache directory for a specific baseline and ref.
 * When commitSha is provided, uses SHA-keyed storage (content-addressed).
 * Falls back to ref-keyed storage only when SHA is unavailable.
 */
export function getCacheDir(baselineUrl, ref, commitSha = null) {
  const cacheName = getCacheName(baselineUrl);
  const cacheRoot = join(homedir(), ".oddkit", "cache", cacheName);
  if (commitSha) {
    return join(cacheRoot, commitSha);
  }
  return join(cacheRoot, ref.replace(/[^a-zA-Z0-9_-]/g, "_"));
}

/**
 * Find the most recent valid cache directory under a parent dir.
 * Scans for SHA-keyed subdirectories that contain a .git directory.
 * Returns { dir, sha } for the most recently modified one, or null.
 *
 * This provides offline resilience: when the network is unavailable,
 * the last-known-good cached content can still be served.
 */
function findLatestCacheDir(parentDir) {
  if (!existsSync(parentDir)) return null;

  try {
    const entries = readdirSync(parentDir);
    let latest = null;
    let latestMtime = 0;

    for (const entry of entries) {
      const candidateDir = join(parentDir, entry);
      const gitDir = join(candidateDir, ".git");
      if (existsSync(gitDir)) {
        // Use .git directory mtime as a proxy for recency
        try {
          const { mtimeMs } = statSync(gitDir);
          if (mtimeMs > latestMtime) {
            latestMtime = mtimeMs;
            // Resolve the actual commit SHA from the cached repo
            let sha = entry; // directory name is the SHA for SHA-keyed dirs
            try {
              sha = execSync("git rev-parse HEAD", { cwd: candidateDir, stdio: "pipe" })
                .toString()
                .trim();
            } catch {
              // Use directory name as fallback
            }
            latest = { dir: candidateDir, sha };
          }
        } catch {
          // Can't stat — skip this entry
        }
      }
    }

    return latest;
  } catch {
    return null;
  }
}

/**
 * Ensure the baseline repo is available.
 *
 * Content-addressed caching strategy:
 *   1. Resolve the current commit SHA for the baseline branch (lightweight git ls-remote)
 *   2. Use that SHA as the storage namespace key
 *   3. If content for this exact SHA exists locally, serve it — this is truthful
 *   4. If the SHA has changed or no content exists, fetch fresh and store keyed to the new SHA
 *   No TTL. No staleness window. No manual flush for correctness.
 *
 * Resolution order:
 *   1. cliOverride parameter (from --baseline flag)
 *   2. ODDKIT_BASELINE environment variable
 *   3. Default: https://github.com/klappy/klappy.dev.git
 *
 * Options:
 *   - checkOnly: If true, only check for changes without fetching (returns changed: boolean)
 *
 * Returns { root, ref, source, baselineUrl, commitSha } or { root: null, error }
 */
export async function ensureBaselineRepo(cliOverride = null, options = {}) {
  const { checkOnly = false } = options;
  const { url: baselineUrl, source: baselineSource } = resolveBaselineSource(cliOverride);
  const ref = getBaselineRef();
  const refSource = process.env.ODDKIT_BASELINE_REF ? "environment" : "defaulted";

  // Handle local path - no cloning needed
  if (isLocalPath(baselineUrl)) {
    const localPath = baselineUrl.startsWith("~")
      ? join(homedir(), baselineUrl.slice(1))
      : resolve(baselineUrl);

    if (!existsSync(localPath)) {
      return {
        root: null,
        ref,
        refSource,
        baselineUrl,
        baselineSource,
        error: `Local baseline path does not exist: ${localPath}`,
      };
    }

    // Get commit SHA if it's a git repo
    let commitSha = null;
    try {
      commitSha = execSync("git rev-parse HEAD", { cwd: localPath, stdio: "pipe" })
        .toString()
        .trim();
    } catch {
      // Not a git repo or can't get SHA
    }

    sessionResolvedSha = commitSha;
    sessionResolvedKey = `${baselineUrl}|local`;

    return {
      root: localPath,
      ref: "local",
      refSource: "local",
      baselineUrl,
      baselineSource,
      commitSha,
      error: null,
    };
  }

  // Handle git URL - clone/fetch as needed
  if (!isGitUrl(baselineUrl)) {
    return {
      root: null,
      ref,
      refSource,
      baselineUrl,
      baselineSource,
      error: `Invalid baseline: ${baselineUrl} (expected git URL or local path)`,
    };
  }

  try {
    // Check if git is available
    execSync("git --version", { stdio: "pipe" });
  } catch {
    return {
      root: null,
      ref,
      refSource,
      baselineUrl,
      baselineSource,
      error: "git not installed",
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Step 1: Resolve the current commit SHA for this branch.
  // This is one lightweight network call (~100 bytes via git ls-remote).
  // Within a single process, we cache this to avoid redundant network hits
  // across multiple actions in the same session.
  // ────────────────────────────────────────────────────────────────────────

  const sessionKey = `${baselineUrl}|${ref}`;
  let remoteSha = null;

  if (sessionResolvedSha && sessionResolvedKey === sessionKey) {
    // Reuse within the same process session (not across processes)
    remoteSha = sessionResolvedSha;
  } else {
    const changeCheck = checkRemoteForChanges(baselineUrl, ref);
    remoteSha = changeCheck.currentSha;

    if (remoteSha) {
      sessionResolvedSha = remoteSha;
      sessionResolvedKey = sessionKey;
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Step 2: Check if we have content for this exact SHA already cached.
  // Content-addressed: if the SHA matches, the content is correct by identity.
  // ────────────────────────────────────────────────────────────────────────

  const parentDir = join(homedir(), ".oddkit", "cache", getCacheName(baselineUrl));
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  // If we have the remote SHA, check for an exact-SHA cache hit
  if (remoteSha) {
    const shaCacheDir = getCacheDir(baselineUrl, ref, remoteSha);

    if (existsSync(join(shaCacheDir, ".git"))) {
      // Content-addressed cache hit: SHA matches, content is truthful
      if (checkOnly) {
        return {
          root: shaCacheDir,
          ref,
          refSource,
          baselineUrl,
          baselineSource,
          commitSha: remoteSha,
          changed: false,
          remoteSha,
          error: null,
        };
      }

      return {
        root: shaCacheDir,
        ref,
        refSource,
        baselineUrl,
        baselineSource,
        commitSha: remoteSha,
        error: null,
      };
    }

    if (checkOnly) {
      return {
        root: null,
        ref,
        refSource,
        baselineUrl,
        baselineSource,
        commitSha: null,
        changed: true,
        remoteSha,
        error: null,
      };
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Step 3: Offline resilience — when network is unavailable (remoteSha is
  // null), fall back to the most recent existing SHA-keyed cache directory.
  // A transient network blip should serve last-known-good content, not
  // hard-fail when perfectly good cached content exists.
  // ────────────────────────────────────────────────────────────────────────

  if (!remoteSha) {
    const fallback = findLatestCacheDir(parentDir);
    if (fallback) {
      sessionResolvedSha = fallback.sha;
      sessionResolvedKey = sessionKey;

      return {
        root: fallback.dir,
        ref,
        refSource,
        baselineUrl,
        baselineSource,
        commitSha: fallback.sha,
        error: null,
      };
    }
    // No existing cache either — fall through to clone attempt (will likely fail too)
  }

  // ────────────────────────────────────────────────────────────────────────
  // Step 4: No exact-SHA cache exists. Clone fresh content keyed to the
  // resolved SHA. If clone fails, fall back to existing cache as well.
  // ────────────────────────────────────────────────────────────────────────

  try {
    // Determine cache directory: SHA-keyed if we know the SHA, ref-keyed as fallback
    const cacheDir = remoteSha
      ? getCacheDir(baselineUrl, ref, remoteSha)
      : getCacheDir(baselineUrl, ref);

    // Clone fresh into SHA-keyed directory
    execSync(`git clone --branch ${ref} --single-branch --depth 1 ${baselineUrl} ${cacheDir}`, {
      stdio: "pipe",
    });

    // Get the resolved commit SHA for reproducibility
    let commitSha = null;
    try {
      commitSha = execSync("git rev-parse HEAD", { cwd: cacheDir, stdio: "pipe" })
        .toString()
        .trim();
    } catch {
      // Couldn't get SHA, continue without it
    }

    // If we didn't know the SHA before clone, and the clone landed at a different
    // SHA than expected, update the session cache
    if (commitSha) {
      sessionResolvedSha = commitSha;
      sessionResolvedKey = sessionKey;
    }

    return {
      root: cacheDir,
      ref,
      refSource,
      baselineUrl,
      baselineSource,
      commitSha,
      error: null,
    };
  } catch (err) {
    // Clone failed — fall back to existing cache if available
    const fallback = findLatestCacheDir(parentDir);
    if (fallback) {
      sessionResolvedSha = fallback.sha;
      sessionResolvedKey = sessionKey;

      return {
        root: fallback.dir,
        ref,
        refSource,
        baselineUrl,
        baselineSource,
        commitSha: fallback.sha,
        error: null,
      };
    }

    return {
      root: null,
      ref,
      refSource,
      baselineUrl,
      baselineSource,
      error: err.message || "Failed to clone baseline repo",
    };
  }
}

/**
 * Get the baseline root path (or null if unavailable)
 */
export async function getBaselineRoot(cliOverride = null) {
  const result = await ensureBaselineRepo(cliOverride);
  return result.root;
}
