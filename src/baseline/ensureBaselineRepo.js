import { execSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { join, resolve, isAbsolute } from "path";
import { homedir } from "os";

const DEFAULT_BASELINE_URL = "https://github.com/klappy/klappy.dev.git";
const DEFAULT_REF = "main";

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
  return str.startsWith("/") || str.startsWith("./") || str.startsWith("../") || str.startsWith("~");
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
 * Get the cache directory for a specific baseline and ref
 */
export function getCacheDir(baselineUrl, ref) {
  const cacheName = getCacheName(baselineUrl);
  const cacheRoot = join(homedir(), ".oddkit", "cache", cacheName);
  return join(cacheRoot, ref.replace(/[^a-zA-Z0-9_-]/g, "_"));
}

/**
 * Ensure the baseline repo is available
 * 
 * Resolution order:
 *   1. cliOverride parameter (from --baseline flag)
 *   2. ODDKIT_BASELINE environment variable
 *   3. Default: https://github.com/klappy/klappy.dev.git
 * 
 * Returns { root, ref, source, baselineUrl, commitSha } or { root: null, error }
 */
export async function ensureBaselineRepo(cliOverride = null) {
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

  const cacheDir = getCacheDir(baselineUrl, ref);

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

  try {
    // Ensure cache directory parent exists
    const parentDir = join(homedir(), ".oddkit", "cache", getCacheName(baselineUrl));
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    if (existsSync(join(cacheDir, ".git"))) {
      // Repo exists, fetch and checkout
      try {
        execSync(`git fetch origin`, { cwd: cacheDir, stdio: "pipe" });
        execSync(`git checkout ${ref}`, { cwd: cacheDir, stdio: "pipe" });
        // If ref is a branch, pull latest
        if (ref === "main" || ref === "master") {
          execSync(`git pull origin ${ref}`, { cwd: cacheDir, stdio: "pipe" });
        }
      } catch {
        // Fetch failed, but we have a cached version - use it
      }
    } else {
      // Clone fresh
      execSync(`git clone --branch ${ref} --single-branch ${baselineUrl} ${cacheDir}`, {
        stdio: "pipe",
      });
    }

    // Get the resolved commit SHA for reproducibility
    let commitSha = null;
    try {
      commitSha = execSync("git rev-parse HEAD", { cwd: cacheDir, stdio: "pipe" })
        .toString()
        .trim();
    } catch {
      // Couldn't get SHA, continue without it
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
