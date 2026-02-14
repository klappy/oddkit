import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs";
import { join, relative, dirname } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import fg from "fast-glob";
import matter from "gray-matter";

/**
 * Compute content hash for identity dedup (non-URI fallback)
 * Uses first 8 chars of SHA-256 of normalized content (without frontmatter)
 */
function computeContentHash(content) {
  // Normalize: trim, collapse whitespace
  const normalized = content.trim().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 8);
}

// Schema version — bump when the shape of indexed documents changes.
// A version mismatch triggers a full rebuild so stale fields don't linger.
export const INDEX_VERSION = "1.2.0"; // 1.2.0: added writings/ support, start_here/start_here_order fields

// Default include patterns
const INCLUDE_PATTERNS = ["canon/**/*.md", "odd/**/*.md", "docs/**/*.md", "writings/**/*.md"];

// Default exclude patterns
const EXCLUDE_PATTERNS = ["**/node_modules/**", "**/public/**", "**/.git/**", "**/.oddkit/**"];

/**
 * Check if a file is excluded by a .noindex sentinel in any ancestor directory.
 * @param {string} relFilePath - Relative file path (e.g., "canon/apocrypha/fragments/on-artifacts.md")
 * @param {string} rootPath - Root directory path
 * @returns {boolean} - True if excluded by .noindex
 */
function isExcludedByNoindex(relFilePath, rootPath) {
  const parts = relFilePath.split("/");
  let current = rootPath;

  // Only walk directory parts (exclude filename)
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    if (existsSync(join(current, ".noindex"))) {
      return true;
    }
  }
  return false;
}

/**
 * Extract headings with line numbers from content
 */
function extractHeadings(content) {
  const lines = content.split("\n");
  const headings = [];
  let currentHeading = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^(#{1,6})\s+(.+)$/);

    if (match) {
      // Close previous heading's region
      if (currentHeading) {
        currentHeading.endLine = i - 1;
      }

      currentHeading = {
        level: match[1].length,
        text: match[2].trim(),
        startLine: i,
        endLine: lines.length - 1, // Will be updated when next heading found
      };
      headings.push(currentHeading);
    }
  }

  return headings;
}

/**
 * Build index for a single root directory
 * @returns {{ docs: Array, excludedByNoindex: number }}
 */
async function indexRoot(rootPath, origin) {
  const docs = [];
  let excludedByNoindex = 0;

  // Find all matching files
  const files = await fg(INCLUDE_PATTERNS, {
    cwd: rootPath,
    ignore: EXCLUDE_PATTERNS,
    absolute: false,
  });

  // Filter out files in directories with .noindex sentinel
  const filteredFiles = files.filter((f) => {
    if (isExcludedByNoindex(f, rootPath)) {
      excludedByNoindex++;
      return false;
    }
    return true;
  });

  for (const filePath of filteredFiles) {
    const absolutePath = join(rootPath, filePath);

    try {
      const raw = readFileSync(absolutePath, "utf-8");
      const { data: frontmatter, content } = matter(raw);

      const headings = extractHeadings(content);

      docs.push({
        path: filePath,
        absolutePath,
        origin,
        uri: frontmatter.uri || null,
        title: frontmatter.title || null,
        subtitle: frontmatter.subtitle || null,
        tags: frontmatter.tags || [],
        supersedes: frontmatter.supersedes || null,
        authority_band: inferAuthorityBand(filePath, frontmatter),
        // Arbitration signals (per canon/weighted-relevance-and-arbitration.md)
        scope: frontmatter.scope || null, // attempt | feature | prd | lane | repo
        scope_key: frontmatter.scope_key || null, // identifier for scope
        intent: inferIntent(filePath, frontmatter), // workaround | experiment | operational | pattern | promoted
        evidence: frontmatter.evidence || "none", // none | weak | medium | strong
        // Start here metadata (for catalog ordering)
        start_here: frontmatter.start_here === true,
        start_here_order: typeof frontmatter.start_here_order === "number" ? frontmatter.start_here_order : null,
        start_here_label: frontmatter.start_here_label || null,
        // Identity for dedup (per user critique: path-only is unsafe across repos)
        content_hash: computeContentHash(content), // 8-char SHA-256 of normalized content
        // Full parsed frontmatter for include_metadata support
        frontmatter: Object.keys(frontmatter).length > 0 ? frontmatter : null,
        headings,
        contentLength: content.length,
        contentPreview: content.slice(0, 500),
      });
    } catch (err) {
      // Skip files that can't be read
      console.error(`Warning: Could not index ${filePath}: ${err.message}`);
    }
  }

  return { docs, excludedByNoindex };
}

/**
 * Intent hierarchy values (per canon/weighted-relevance-and-arbitration.md)
 * Lower = less durable, higher = more durable
 */
export const INTENT_HIERARCHY = {
  workaround: 1,
  experiment: 2,
  operational: 3,
  pattern: 4,
  promoted: 5,
};

/**
 * Infer intent from path and frontmatter
 */
function inferIntent(filePath, frontmatter) {
  // Frontmatter override
  if (frontmatter.intent && INTENT_HIERARCHY[frontmatter.intent] !== undefined) {
    return frontmatter.intent;
  }

  // Path-based inference
  if (filePath.startsWith("canon/")) {
    return "promoted"; // Canon is governing, always promoted
  }
  if (filePath.startsWith("odd/")) {
    return "pattern"; // ODD docs are patterns
  }
  if (filePath.startsWith("writings/")) {
    return "promoted"; // Writings are primary public-facing essays
  }
  if (filePath.includes("/workaround")) {
    return "workaround";
  }
  if (filePath.includes("/experiment")) {
    return "experiment";
  }

  // Default to operational
  return "operational";
}

/**
 * Infer authority band from path and frontmatter
 */
function inferAuthorityBand(filePath, frontmatter) {
  // Frontmatter override
  if (frontmatter.authority_band) {
    return frontmatter.authority_band;
  }

  // Path-based inference
  if (filePath.startsWith("canon/") || filePath.startsWith("odd/") || filePath.startsWith("writings/")) {
    return "governing";
  }
  if (filePath.startsWith("docs/")) {
    return "operational";
  }
  return "non-governing";
}

/**
 * Build complete index for local repo + baseline
 */
export async function buildIndex(repoRoot, baselineRoot = null) {
  const localResult = await indexRoot(repoRoot, "local");
  const localDocs = localResult.docs;
  const localExcluded = localResult.excludedByNoindex;

  let baselineDocs = [];
  let baselineExcluded = 0;
  if (baselineRoot) {
    const baselineResult = await indexRoot(baselineRoot, "baseline");
    baselineDocs = baselineResult.docs;
    baselineExcluded = baselineResult.excludedByNoindex;
  }

  const allDocs = [...localDocs, ...baselineDocs];

  const index = {
    version: INDEX_VERSION,
    generated: new Date().toISOString(),
    stats: {
      total: allDocs.length,
      local: localDocs.length,
      baseline: baselineDocs.length,
      excluded_by_noindex: localExcluded + baselineExcluded,
      byAuthority: {
        governing: allDocs.filter((d) => d.authority_band === "governing").length,
        operational: allDocs.filter((d) => d.authority_band === "operational").length,
        "non-governing": allDocs.filter((d) => d.authority_band === "non-governing").length,
      },
    },
    documents: allDocs,
  };

  return index;
}

/**
 * Save index to disk
 */
export function saveIndex(index, repoRoot) {
  const indexDir = join(repoRoot, ".oddkit");
  if (!existsSync(indexDir)) {
    mkdirSync(indexDir, { recursive: true });
  }

  const indexPath = join(indexDir, "index.json");
  writeFileSync(indexPath, JSON.stringify(index, null, 2));

  return indexPath;
}

/**
 * Save baseline index to cache (SHA-keyed).
 * When commitSha is provided, uses content-addressed storage.
 */
export function saveBaselineIndex(index, ref, commitSha = null) {
  const cacheDir = join(homedir(), ".oddkit", "cache", "indexes");
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }

  // SHA-keyed: use commit SHA as the key for truthful storage
  const key = commitSha || ref.replace(/[^a-zA-Z0-9_-]/g, "_");
  const indexPath = join(cacheDir, `klappy.dev-${key}.json`);
  writeFileSync(indexPath, JSON.stringify(index, null, 2));

  return indexPath;
}

/**
 * Load index from disk if it exists and is fresh
 */
export function loadIndex(repoRoot) {
  const indexPath = join(repoRoot, ".oddkit", "index.json");

  if (!existsSync(indexPath)) {
    return null;
  }

  try {
    const raw = readFileSync(indexPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Load baseline index from cache (SHA-keyed).
 * When commitSha is provided, loads content-addressed index.
 */
export function loadBaselineIndex(ref, commitSha = null) {
  const key = commitSha || ref.replace(/[^a-zA-Z0-9_-]/g, "_");
  const indexPath = join(
    homedir(),
    ".oddkit",
    "cache",
    "indexes",
    `klappy.dev-${key}.json`,
  );

  if (!existsSync(indexPath)) {
    return null;
  }

  try {
    const raw = readFileSync(indexPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
