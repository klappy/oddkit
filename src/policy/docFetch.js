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
import matter from "gray-matter";
import { resolveCanonTarget } from "./canonTarget.js";
import { ensureBaselineRepo } from "../baseline/ensureBaselineRepo.js";
import { extractHeadings } from "../utils/extractHeadings.js";

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
 * Extract a section from markdown content by heading text.
 * Returns content from the matching heading through the line before
 * the next heading at the same or higher level.
 *
 * Matching: exact match first (case-insensitive), then partial.
 * If multiple partial matches, returns first with a warning listing alternatives.
 *
 * @param {string} content - Full markdown content
 * @param {string} sectionName - Heading text to match
 * @returns {{ content: string, matched: string, warning?: string } | null}
 */
function extractSection(content, sectionName) {
  // Strip YAML frontmatter so YAML comments (# ...) aren't parsed as headings
  const fmMatch = content.match(/^---\n[\s\S]*?\n---\n/);
  const body = fmMatch ? content.slice(fmMatch[0].length) : content;

  const headings = extractHeadings(body);
  if (headings.length === 0) return null;

  const needle = sectionName.toLowerCase();

  // Try exact match first (case-insensitive)
  let target = headings.find((h) => h.text.toLowerCase() === needle);
  let partialWarning = null;

  // Fall back to partial match
  if (!target) {
    const partials = headings.filter((h) => h.text.toLowerCase().includes(needle));
    if (partials.length === 0) return null;
    target = partials[0];
    if (partials.length > 1) {
      partialWarning = `Multiple partial matches found. Returning first match. Alternatives: ${partials
        .slice(1)
        .map((h) => h.text)
        .join(", ")}`;
    }
  }

  // Find end of section: next heading at same or higher (lower number) level
  const lines = body.split("\n");
  const targetIdx = headings.indexOf(target);
  let endLine = lines.length - 1;
  for (let i = targetIdx + 1; i < headings.length; i++) {
    if (headings[i].level <= target.level) {
      endLine = headings[i].startLine - 1;
      break;
    }
  }
  const result = {
    content: lines.slice(target.startLine, endLine + 1).join("\n"),
    matched: target.text,
  };
  if (partialWarning) result.warning = partialWarning;
  return result;
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
  const {
    format = "markdown",
    baseline = null,
    include_metadata = false,
    section = null,
  } = options;

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

  // Compute hash of full file (before section extraction)
  const contentHash = computeHash(content);
  const fullContent = content;

  // Section extraction: if requested, extract a single section by heading
  let sectionWarning = null;
  if (section) {
    const extracted = extractSection(content, section);
    if (extracted) {
      content = extracted.content;
      if (extracted.warning) sectionWarning = extracted.warning;
    } else {
      // Section not found — return full file with warning
      sectionWarning = `Section "${section}" not found. Returning full file.`;
    }
  }

  // Return result
  const result = {
    uri,
    canon_commit: canonTarget.commit,
    canon_commit_full: canonTarget.commitFull || null,
    content_hash: contentHash,
    format,
  };

  if (section) {
    result.section = section;
    if (sectionWarning) result.section_warning = sectionWarning;
  }

  if (format === "markdown") {
    result.content = content;
  } else if (format === "json") {
    // For JSON format, try to extract frontmatter from full file content
    const frontmatterMatch = fullContent.match(/^---\n([\s\S]*?)\n---\n/);
    if (frontmatterMatch) {
      result.frontmatter = frontmatterMatch[1];
      result.body = content.startsWith(frontmatterMatch[0])
        ? content.slice(frontmatterMatch[0].length)
        : content;
    } else {
      result.body = content;
    }
  }

  // When include_metadata is true, parse full file for frontmatter
  if (include_metadata) {
    try {
      const { data } = matter(fullContent);
      if (data && Object.keys(data).length > 0) {
        result.metadata = data;
      }
    } catch {
      // Frontmatter parsing failed — omit metadata silently
    }
  }

  return result;
}
