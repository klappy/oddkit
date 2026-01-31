/**
 * docFetch.js
 *
 * Fetches canonical documents by klappy:// URI at the current canon target.
 * Used by oddkit_policy_get MCP tool.
 */

import { createHash } from "crypto";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import path from "path";
import { resolveCanonTarget } from "./canonTarget.js";
import { ensureBaselineRepo } from "../baseline/ensureBaselineRepo.js";

/**
 * Security: reject null bytes in URI paths
 */
function assertNoNullBytes(input, label) {
  if (input.includes("\0")) {
    throw new Error(`Invalid ${label}: contains null byte`);
  }
}

/**
 * Security: ensure a requested path stays within a prefix directory.
 * Uses POSIX normalization and containment checks.
 *
 * @param {string} prefixDir - The directory prefix (e.g., "odd" or "" for repo root)
 * @param {string} requested - The requested path segment (no scheme)
 * @returns {string} - Safe normalized path under prefixDir
 * @throws {Error} - If path escapes containment
 */
function safeSubpath(prefixDir, requested) {
  assertNoNullBytes(requested, "URI path");

  // Normalize using POSIX rules so "/" is the separator regardless of OS
  let norm = path.posix.normalize(requested);

  // Remove any leading slashes after normalization (disallow absolute)
  if (norm.startsWith("/")) {
    throw new Error(`Invalid URI: absolute paths not allowed`);
  }

  // Disallow traversal and Windows separators
  if (norm === ".." || norm.startsWith("../") || norm.includes("/../") || norm.includes("\\")) {
    throw new Error(`Invalid URI: path traversal not allowed`);
  }

  // Join under the prefix using posix
  const joined = prefixDir ? path.posix.join(prefixDir, norm) : norm;

  // Final check: must remain under prefixDir (if prefixDir is non-empty)
  if (prefixDir && joined !== prefixDir && !joined.startsWith(prefixDir + "/")) {
    throw new Error(`Invalid URI: escapes ${prefixDir}/`);
  }

  return joined;
}

/**
 * Map a klappy:// or odd:// URI to a file path relative to baseline root.
 *
 * Security: Uses safeSubpath() to prevent path traversal attacks.
 *
 * Examples:
 *   klappy://canon/agents/odd-epistemic-guide → canon/agents/odd-epistemic-guide.md
 *   odd://contract/epistemic-contract → odd/contract/epistemic-contract.md
 *
 * Note on scheme separation:
 *   - odd:// is reserved for baseline-embedded ODD artifacts (portable, instance-independent)
 *   - klappy:// is for instance-level docs (klappy.dev specific)
 *   - odd:// is NOT an alias of klappy://odd/... — this preserves epistemic separation
 *
 * @param {string} uri
 * @returns {string} Relative path (may need .md extension added)
 */
function uriToPath(uri) {
  // Handle odd:// URIs (portable ODD-level docs)
  // Maps odd://<path> -> odd/<path>.md (or .json)
  // odd:// is reserved for baseline-embedded ODD artifacts
  // and MUST stay within odd/
  if (uri.startsWith("odd://")) {
    let p = uri.slice("odd://".length);

    // Add extension if missing
    if (!p.endsWith(".md") && !p.endsWith(".json")) {
      p = p + ".md";
    }

    // Use safeSubpath to enforce containment within odd/
    return safeSubpath("odd", p);
  }

  // Handle klappy:// URIs (instance-level docs)
  if (!uri.startsWith("klappy://")) {
    throw new Error(`Invalid URI: must start with klappy:// or odd:// (got: ${uri})`);
  }

  let p = uri.slice("klappy://".length);

  // Add .md extension if not present
  if (!p.endsWith(".md") && !p.endsWith(".json")) {
    p = p + ".md";
  }

  // klappy:// is instance-level, but still must be a safe relative subpath
  // (no traversal outside baseline root)
  return safeSubpath("", p);
}

/**
 * Try multiple path variations to find the file.
 *
 * @param {string} baseRoot - Baseline root directory
 * @param {string} basePath - Base path from URI
 * @returns {string | null} - Full path if found, null otherwise
 */
function findDocPath(baseRoot, basePath) {
  // Try exact path first
  const exactPath = join(baseRoot, basePath);
  if (existsSync(exactPath)) {
    return exactPath;
  }

  // Try with different naming conventions
  // e.g., klappy://odd/getting-started/agents-and-mcp might be at odd/getting-started/odd-agents-and-mcp.md
  const dir = basePath.slice(0, basePath.lastIndexOf("/"));
  const filename = basePath.slice(basePath.lastIndexOf("/") + 1);

  // Try prefixing with folder name
  const parts = dir.split("/");
  if (parts.length > 0) {
    const prefix = parts[parts.length - 1];
    const prefixedPath = join(baseRoot, dir, `${prefix}-${filename.replace(".md", "")}.md`);
    if (existsSync(prefixedPath)) {
      return prefixedPath;
    }
  }

  // Try odd-prefixed for getting-started
  if (dir.includes("getting-started")) {
    const oddPrefixed = join(baseRoot, dir, `odd-${filename.replace(".md", "")}.md`);
    if (existsSync(oddPrefixed)) {
      return oddPrefixed;
    }
  }

  return null;
}

/**
 * Compute SHA-256 hash of content.
 *
 * @param {string} content
 * @returns {string}
 */
function computeHash(content) {
  return "sha256:" + createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Fetch a document by klappy:// URI.
 *
 * @param {string} uri - Canonical URI (e.g., klappy://canon/agents/odd-epistemic-guide)
 * @param {Object} options
 * @param {string} [options.format="markdown"] - Output format
 * @param {string} [options.baseline] - Optional baseline override
 * @returns {Promise<Object>} Document result
 */
export async function getDocByUri(uri, options = {}) {
  const { format = "markdown", baseline = null } = options;

  // Resolve canon target
  const canonTarget = await resolveCanonTarget(baseline);

  if (canonTarget.error) {
    return {
      uri,
      canon_commit: null,
      error: {
        code: "CANON_TARGET_UNKNOWN",
        message: canonTarget.error,
      },
    };
  }

  // Get baseline root
  const baselineResult = await ensureBaselineRepo(baseline);

  if (!baselineResult.root) {
    return {
      uri,
      canon_commit: canonTarget.commit,
      error: {
        code: "BASELINE_UNAVAILABLE",
        message: baselineResult.error || "Baseline not available",
      },
    };
  }

  // Map URI to file path
  const basePath = uriToPath(uri);
  const fullPath = findDocPath(baselineResult.root, basePath);

  if (!fullPath) {
    return {
      uri,
      canon_commit: canonTarget.commit,
      error: {
        code: "DOC_NOT_FOUND",
        message: `Document not found: ${uri} (tried: ${basePath})`,
      },
    };
  }

  // Read file
  let content;
  try {
    content = readFileSync(fullPath, "utf-8");
  } catch (err) {
    return {
      uri,
      canon_commit: canonTarget.commit,
      error: {
        code: "DOC_READ_ERROR",
        message: err.message,
      },
    };
  }

  // Compute hash
  const contentHash = computeHash(content);

  // Return result
  const result = {
    uri,
    canon_commit: canonTarget.commit,
    canon_commit_full: canonTarget.commitFull || null,
    content_hash: contentHash,
    format,
  };

  if (format === "markdown") {
    result.content = content;
  } else if (format === "json") {
    // For JSON format, try to extract frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
    if (frontmatterMatch) {
      result.frontmatter = frontmatterMatch[1];
      result.body = content.slice(frontmatterMatch[0].length);
    } else {
      result.body = content;
    }
  }

  return result;
}
