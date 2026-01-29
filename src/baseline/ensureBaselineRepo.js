import { execSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const BASELINE_REPO_URL = "https://github.com/klappy/klappy.dev.git";
const DEFAULT_REF = "main";

/**
 * Get the baseline ref from environment or default
 */
export function getBaselineRef() {
  return process.env.ODDKIT_BASELINE_REF || DEFAULT_REF;
}

/**
 * Get the cache directory for a specific ref
 */
export function getCacheDir(ref) {
  const cacheRoot = join(homedir(), ".oddkit", "cache", "klappy.dev");
  return join(cacheRoot, ref.replace(/[^a-zA-Z0-9_-]/g, "_"));
}

/**
 * Ensure the baseline repo is cloned and at the correct ref
 * Returns { root, ref, source } or { root: null, error }
 */
export async function ensureBaselineRepo() {
  const ref = getBaselineRef();
  const cacheDir = getCacheDir(ref);
  const refSource = process.env.ODDKIT_BASELINE_REF ? "environment" : "defaulted";

  try {
    // Check if git is available
    execSync("git --version", { stdio: "pipe" });
  } catch {
    return {
      root: null,
      ref,
      refSource,
      error: "git not installed",
    };
  }

  try {
    // Ensure cache directory exists
    const parentDir = join(homedir(), ".oddkit", "cache", "klappy.dev");
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
      execSync(`git clone --branch ${ref} --single-branch ${BASELINE_REPO_URL} ${cacheDir}`, {
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
      commitSha,
      error: null,
    };
  } catch (err) {
    return {
      root: null,
      ref,
      refSource,
      error: err.message || "Failed to clone baseline repo",
    };
  }
}

/**
 * Get the baseline root path (or null if unavailable)
 */
export async function getBaselineRoot() {
  const result = await ensureBaselineRepo();
  return result.root;
}
