/**
 * ZipBaselineFetcher - Content-addressed caching for baseline repos
 *
 * Architecture:
 * - Resolves current commit SHA via lightweight GitHub API call
 * - Uses SHA + INDEX_VERSION as cache key — content is truthful by identity,
 *   and code changes to the indexing pipeline invalidate stale indexes
 * - Fetches entire repo as ZIP from GitHub when SHA changes
 * - Extracts files lazily using fflate
 * - Caches in R2 keyed to SHA for fast subsequent access
 * - Supports canon repo overrides with klappy.dev fallback
 * - No TTL. No staleness window. No manual flush for correctness.
 */

import { unzipSync } from "fflate";

// Index schema version — included in KV cache key so that code changes
// to the indexing pipeline (filters, fields, scoring) invalidate stale indexes.
// Bump when indexing logic changes. Without this, a cached index built by
// old code persists until the repo's commit SHA changes.
const INDEX_VERSION = "2.3"; // 2.3: branch ref extraction fix + full frontmatter (E0007)

export interface Env {
  BASELINE_URL: string;
  ODDKIT_VERSION: string;
  BASELINE_CACHE?: KVNamespace;
  BASELINE?: R2Bucket;
  OPENAI_API_KEY?: string;
}

export interface IndexEntry {
  path: string;
  uri: string;
  title: string;
  intent?: string;
  authority_band?: string;
  tags?: string[];
  excerpt?: string;
  content_hash?: string;
  source: "canon" | "baseline";
  frontmatter?: Record<string, unknown>;
}

export interface BaselineIndex {
  version: string;
  generated_at: string;
  canon_url?: string;
  baseline_url: string;
  entries: IndexEntry[];
  stats: {
    total: number;
    canon: number;
    baseline: number;
  };
  commit_sha?: string;
  canon_commit_sha?: string;
}

export interface ChangeCheckResult {
  changed: boolean;
  current_sha?: string;
  cached_sha?: string;
  error?: string;
}

interface FrontmatterResult {
  title?: string;
  intent?: string;
  authority_band?: string;
  tags?: string[];
  uri?: string;
  exposure?: string;
  [key: string]: unknown; // Full frontmatter passthrough for metadata exposure
}

// ──────────────────────────────────────────────────────────────────────────────
// Content-addressed caching: No TTLs. All storage is keyed to commit SHA +
// INDEX_VERSION. When the SHA changes OR the indexing code changes (version
// bump), old content is ignored and fresh content is fetched.
// No staleness window. No manual flush for correctness.
// ──────────────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────────────
// Shared YAML frontmatter parser — used at index time AND request time so that
// metadata is consistent across all APIs (catalog, search, get).
// ──────────────────────────────────────────────────────────────────────────────

function fmParseScalarValue(raw: string): unknown {
  if (!raw) return "";
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null" || raw === "~") return null;
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw);
  return raw;
}

function fmParseInlineArray(raw: string): unknown[] {
  const inner = raw.slice(1, raw.lastIndexOf("]")).trim();
  if (!inner) return [];
  return inner.split(",").map((item) => fmParseScalarValue(item.trim()));
}

function fmParseYamlList(lines: string[]): unknown[] {
  const items: unknown[] = [];
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith("- ")) { i++; continue; }
    const value = trimmed.slice(2).trim();
    const objectProps: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const nextLine = lines[j];
      const nextTrimmed = nextLine.trim();
      if (!nextTrimmed || nextTrimmed.startsWith("- ")) break;
      const itemIndent = lines[i].search(/\S/);
      const nextIndent = nextLine.search(/\S/);
      if (nextIndent <= itemIndent) break;
      objectProps.push(nextTrimmed);
      j++;
    }
    if (objectProps.length > 0) {
      const obj: Record<string, unknown> = {};
      const firstColonIdx = value.indexOf(":");
      if (firstColonIdx !== -1) {
        const k = value.slice(0, firstColonIdx).trim();
        const v = value.slice(firstColonIdx + 1).trim();
        if (k) obj[k] = fmParseScalarValue(v);
      }
      for (const prop of objectProps) {
        const propColonIdx = prop.indexOf(":");
        if (propColonIdx !== -1) {
          const k = prop.slice(0, propColonIdx).trim();
          const v = prop.slice(propColonIdx + 1).trim();
          if (k) obj[k] = fmParseScalarValue(v);
        }
      }
      items.push(obj);
      i = j;
    } else {
      items.push(fmParseScalarValue(value));
      i++;
    }
  }
  return items;
}

function fmParseYamlObject(lines: string[]): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  if (lines.length === 0) return obj;
  const baseIndent = lines[0].search(/\S/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) { i++; continue; }
    const currentIndent = line.search(/\S/);
    if (currentIndent > baseIndent) { i++; continue; }
    if (currentIndent < baseIndent) break;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) { i++; continue; }
    const key = trimmed.slice(0, colonIdx).trim();
    const rawValue = trimmed.slice(colonIdx + 1).trim();
    if (!key) { i++; continue; }
    if (!rawValue) {
      i++;
      const nested: string[] = [];
      while (i < lines.length) {
        const nextLine = lines[i];
        const nextTrimmed = nextLine.trim();
        if (!nextTrimmed) { i++; continue; }
        const nextIndent = nextLine.search(/\S/);
        if (nextIndent <= baseIndent) break;
        if (nextTrimmed.startsWith("#")) { i++; continue; }
        nested.push(nextLine);
        i++;
      }
      if (nested.length > 0) {
        if (nested[0].trim().startsWith("- ")) {
          obj[key] = fmParseYamlList(nested);
        } else {
          obj[key] = fmParseYamlObject(nested);
        }
      }
    } else if (rawValue.startsWith("[")) {
      obj[key] = fmParseInlineArray(rawValue);
      i++;
    } else {
      obj[key] = fmParseScalarValue(rawValue);
      i++;
    }
  }
  return obj;
}

export function parseFullFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yaml = match[1];
  const result: Record<string, unknown> = {};
  const lines = yaml.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) { i++; continue; }
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) { i++; continue; }
    const key = trimmed.slice(0, colonIdx).trim();
    const rawValue = trimmed.slice(colonIdx + 1).trim();
    if (!key) { i++; continue; }
    if (!rawValue) {
      i++;
      const items: string[] = [];
      while (i < lines.length) {
        const nextLine = lines[i];
        const nextTrimmed = nextLine.trim();
        if (!nextTrimmed) { i++; continue; }
        if (!nextLine.startsWith("  ") && !nextLine.startsWith("\t")) break;
        if (nextTrimmed.startsWith("#")) { i++; continue; }
        items.push(nextLine);
        i++;
      }
      if (items.length > 0) {
        if (items[0].trim().startsWith("- ")) {
          result[key] = fmParseYamlList(items);
        } else {
          result[key] = fmParseYamlObject(items);
        }
      }
    } else if (rawValue.startsWith("[")) {
      result[key] = fmParseInlineArray(rawValue);
      i++;
    } else {
      result[key] = fmParseScalarValue(rawValue);
      i++;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Parse YAML frontmatter for index-time use, returning FrontmatterResult.
 * Delegates to the full parser for consistency across all APIs.
 */
function parseFrontmatter(content: string): FrontmatterResult {
  const full = parseFullFrontmatter(content);
  if (!full) return {};

  const result: FrontmatterResult = { ...full };

  if (typeof result.tags === "string") {
    result.tags = [result.tags];
  } else if (Array.isArray(result.tags)) {
    result.tags = result.tags.map((t) => String(t));
  }

  return result;
}

/**
 * Extract title from markdown content (fallback if no frontmatter)
 */
function extractTitle(content: string, path: string): string {
  // Try first heading
  const headingMatch = content.match(/^#\s+(.+)$/m);
  if (headingMatch) return headingMatch[1];

  // Fallback to filename
  const filename = path.split("/").pop() || path;
  return filename.replace(/\.md$/, "").replace(/[-_]/g, " ");
}

/**
 * Generate excerpt from markdown content
 */
function extractExcerpt(content: string): string {
  // Strip frontmatter
  const stripped = content.replace(/^---[\s\S]*?---\n/, "");
  // Get first paragraph (non-heading, non-empty lines)
  const lines = stripped.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  return lines.slice(0, 2).join(" ").slice(0, 200);
}

export interface SectionResult {
  found: boolean;
  content?: string;
  section?: string;
  available_sections?: string[];
  error?: string;
}

/**
 * Extract a section from markdown content by ## header title.
 * Returns content from the matched ## header to the next ## header (or EOF).
 * If section is not found, returns the list of available ## headers.
 */
export function extractSection(content: string, section: string): SectionResult {
  // Escape regex special chars in section title
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headerPattern = new RegExp(`^## ${escaped}\\s*$`, "mi");
  const startMatch = content.match(headerPattern);

  if (startMatch && startMatch.index !== undefined) {
    const rest = content.slice(startMatch.index);
    const nextHeader = rest.indexOf("\n## ");
    const sectionContent = nextHeader > 0 ? rest.slice(0, nextHeader) : rest;
    return { found: true, content: sectionContent, section };
  }

  // Fall back to partial match (case-insensitive)
  const allHeaders = [...content.matchAll(/^## (.+)$/gm)];
  const needle = section.toLowerCase();
  const partials = allHeaders.filter((m) => m[1].toLowerCase().includes(needle));

  if (partials.length > 0 && partials[0].index !== undefined) {
    const rest = content.slice(partials[0].index!);
    const nextHeader = rest.indexOf("\n## ");
    const sectionContent = nextHeader > 0 ? rest.slice(0, nextHeader) : rest;
    return { found: true, content: sectionContent, section: partials[0][1] };
  }

  // Section not found — return available headers
  const available = allHeaders.map((m) => m[1]);
  return {
    found: false,
    error: `Section not found: "${section}"`,
    section,
    available_sections: available,
  };
}

/**
 * Simple hash function for content
 */
function hashContent(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Extract branch ref from a GitHub URL.
 * raw.githubusercontent.com URLs encode the branch as the third path segment;
 * all other URLs default to "main".
 */
function extractBranchRef(url: string): string {
  const cleanUrl = url.replace(/\.git$/, "").replace(/\/$/, "");
  if (cleanUrl.includes("raw.githubusercontent.com")) {
    const parts = cleanUrl.replace("https://raw.githubusercontent.com/", "").split("/");
    if (parts[2]) return parts[2];
  }
  return "main";
}

/**
 * Convert GitHub repo URL to ZIP download URL
 */
function getZipUrl(repoUrl: string, ref: string = "main"): string {
  // Handle various URL formats
  // https://github.com/owner/repo -> https://github.com/owner/repo/archive/main.zip
  // https://raw.githubusercontent.com/owner/repo/branch -> https://github.com/owner/repo/archive/branch.zip

  let cleanUrl = repoUrl
    .replace(/\.git$/, "")
    .replace(/\/$/, "");

  if (cleanUrl.includes("raw.githubusercontent.com")) {
    // Convert raw URL to repo URL, extracting branch ref if present
    const parts = cleanUrl.replace("https://raw.githubusercontent.com/", "").split("/");
    cleanUrl = `https://github.com/${parts[0]}/${parts[1]}`;
    // parts[2] is the branch ref (e.g., "e0007-proactive-posture" or "main")
    if (parts[2]) {
      ref = parts[2];
    }
  }

  return `${cleanUrl}/archive/${ref}.zip`;
}

/**
 * Generate cache key from URL
 */
function getCacheKey(url: string): string {
  return url
    .replace(/https?:\/\//, "")
    .replace(/[^a-zA-Z0-9]/g, "_")
    .slice(0, 100);
}

/**
 * Extract owner/repo from GitHub URL
 * e.g., "https://github.com/klappy/klappy.dev" -> { owner: "klappy", repo: "klappy.dev" }
 */
function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const cleanUrl = url
    .replace(/\.git$/, "")
    .replace(/\/$/, "");

  // Handle raw.githubusercontent.com URLs
  if (cleanUrl.includes("raw.githubusercontent.com")) {
    const match = cleanUrl.match(/raw\.githubusercontent\.com\/([^\/]+)\/([^\/]+)/);
    if (match) {
      return { owner: match[1], repo: match[2] };
    }
  }

  // Handle github.com URLs
  const match = cleanUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (match) {
    return { owner: match[1], repo: match[2] };
  }

  return null;
}

export class ZipBaselineFetcher {
  private env: Env;
  private zipCache: Map<string, Uint8Array> = new Map();
  private unzippedCache: Map<string, Record<string, Uint8Array>> = new Map();
  private commitCache: Map<string, string> = new Map();

  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Get unzipped file map, caching the result to avoid repeated decompression.
   * unzipSync is CPU-intensive; calling it once per ZIP per request
   * keeps us within Cloudflare Worker CPU limits.
   *
   * When a filter is provided, only matching files are decompressed (fflate
   * skips decompression for non-matching entries). Filtered and unfiltered
   * results use separate cache keys so getFile() (needs all types) and
   * extractMarkdownFiles() (needs .md only) don't interfere.
   */
  private getUnzipped(
    zipData: Uint8Array,
    cacheKey: string,
    filter?: (file: { name: string }) => boolean,
  ): Record<string, Uint8Array> {
    const effectiveKey = filter ? `${cacheKey}:filtered` : cacheKey;
    const existing = this.unzippedCache.get(effectiveKey);
    if (existing) {
      return existing;
    }
    const unzipped = filter
      ? unzipSync(zipData, { filter })
      : unzipSync(zipData);
    this.unzippedCache.set(effectiveKey, unzipped);
    return unzipped;
  }

  /**
   * Get latest commit SHA from GitHub API (lightweight ~100 bytes)
   * Uses Accept header to get just the SHA, not full commit object
   */
  private async getLatestCommitSha(
    repoUrl: string,
    ref: string = "main"
  ): Promise<string | null> {
    const parsed = parseGitHubUrl(repoUrl);
    if (!parsed) {
      console.warn(`Cannot parse GitHub URL: ${repoUrl}`);
      return null;
    }

    const { owner, repo } = parsed;
    const cacheKey = `${owner}/${repo}/${ref}`;

    // Check memory cache (very short-lived, per-request dedup)
    if (this.commitCache.has(cacheKey)) {
      return this.commitCache.get(cacheKey)!;
    }

    try {
      // Use GitHub API with Accept header for just SHA (minimal response)
      const response = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/commits/${ref}`,
        {
          headers: {
            "User-Agent": "oddkit-mcp",
            Accept: "application/vnd.github.v3.sha",
          },
        }
      );

      if (!response.ok) {
        console.warn(`GitHub API error: ${response.status} for ${owner}/${repo}`);
        return null;
      }

      const sha = await response.text();
      this.commitCache.set(cacheKey, sha);
      return sha;
    } catch (error) {
      console.error(`Error fetching commit SHA: ${error}`);
      return null;
    }
  }

  /**
   * Check if a repo has changed since last cache
   * Returns { changed, current_sha, cached_sha } for observability
   */
  async checkForChanges(
    repoUrl: string,
    ref: string = "main"
  ): Promise<ChangeCheckResult> {
    const parsed = parseGitHubUrl(repoUrl);
    if (!parsed) {
      return { changed: true, error: "Cannot parse repo URL" };
    }

    // Get current SHA from GitHub API
    const currentSha = await this.getLatestCommitSha(repoUrl, ref);
    if (!currentSha) {
      // Can't check, assume changed to be safe
      return { changed: true, error: "Could not fetch current commit SHA" };
    }

    // Get cached SHA from KV
    const cacheKey = `sha/${getCacheKey(repoUrl)}`;
    let cachedSha: string | null = null;

    if (this.env.BASELINE_CACHE) {
      cachedSha = await this.env.BASELINE_CACHE.get(cacheKey);
    }

    if (!cachedSha) {
      // No cached SHA, first time or expired
      return { changed: true, current_sha: currentSha };
    }

    const changed = currentSha !== cachedSha;
    return { changed, current_sha: currentSha, cached_sha: cachedSha };
  }

  /**
   * Store commit SHA in cache (no TTL — content-addressed).
   * The SHA itself is the identity; it doesn't expire.
   */
  private async cacheCommitSha(repoUrl: string, sha: string): Promise<void> {
    const cacheKey = `sha/${getCacheKey(repoUrl)}`;
    if (this.env.BASELINE_CACHE) {
      await this.env.BASELINE_CACHE.put(cacheKey, sha);
    }
  }

  /**
   * Fetch and cache a ZIP file
   * @param url - GitHub ZIP URL
   * @param skipCache - If true, bypass R2 cache and fetch fresh (used when changes detected)
   */
  private async fetchZip(url: string, skipCache: boolean = false): Promise<Uint8Array | null> {
    const cacheKey = `zip/${getCacheKey(url)}`;

    // Check memory cache first (unless skipping cache)
    if (!skipCache && this.zipCache.has(cacheKey)) {
      return this.zipCache.get(cacheKey)!;
    }

    // Check R2 cache (unless skipping cache)
    if (!skipCache && this.env.BASELINE) {
      const r2Object = await this.env.BASELINE.get(cacheKey);
      if (r2Object) {
        const data = new Uint8Array(await r2Object.arrayBuffer());
        this.zipCache.set(cacheKey, data);
        return data;
      }
    }

    // Fetch from GitHub
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "oddkit-mcp" },
      });

      if (!response.ok) {
        console.error(`Failed to fetch ZIP: ${response.status} ${url}`);
        return null;
      }

      const data = new Uint8Array(await response.arrayBuffer());

      // Cache in R2 (no TTL — content-addressed by SHA at the index/file layer)
      if (this.env.BASELINE) {
        await this.env.BASELINE.put(cacheKey, data, {
          httpMetadata: { contentType: "application/zip" },
          customMetadata: { fetchedAt: new Date().toISOString() },
        });
      }

      // Cache in memory
      this.zipCache.set(cacheKey, data);

      return data;
    } catch (error) {
      console.error(`Error fetching ZIP: ${error}`);
      return null;
    }
  }

  /**
   * Extract markdown files from ZIP and build index entries
   */
  private extractMarkdownFiles(
    zipData: Uint8Array,
    source: "canon" | "baseline",
    zipCacheKey: string
  ): IndexEntry[] {
    const entries: IndexEntry[] = [];

    try {
      const unzipped = this.getUnzipped(zipData, zipCacheKey, (file) => file.name.endsWith(".md"));

      for (const [fullPath, fileData] of Object.entries(unzipped)) {

        // Skip excluded directories
        if (
          fullPath.includes("node_modules/") ||
          fullPath.includes(".git/") ||
          fullPath.includes(".oddkit/")
        ) continue;

        const pathParts = fullPath.split("/");
        // Remove repo-branch prefix (e.g., "klappy.dev-main/")
        const repoPath = pathParts.slice(1).join("/");

        // For the baseline repo, apply a directory whitelist as defense-in-depth
        // (it contains non-document .md files outside canon directories).
        if (
          source === "baseline" &&
          !repoPath.startsWith("canon/") &&
          !repoPath.startsWith("odd/") &&
          !repoPath.startsWith("docs/") &&
          !repoPath.startsWith("writings/")
        ) continue;

        // Decode file content and parse frontmatter
        const content = new TextDecoder().decode(fileData);
        const frontmatter = parseFrontmatter(content);

        // Frontmatter-driven inclusion: index files that declare a title.
        // This satisfies meaning-must-not-depend-on-path — inclusion is
        // determined by what the file declares about itself, not where it lives.
        // For baseline, the directory whitelist above provides defense-in-depth.
        // For supplementary repos, this is the sole inclusion gate.
        if (source === "canon" && !frontmatter.title) continue;

        // Explicit opt-out via frontmatter
        if (frontmatter.exposure === "noindex") continue;

        const entry: IndexEntry = {
          path: repoPath,
          uri: frontmatter.uri || `klappy://${repoPath.replace(/\.md$/, "")}`,
          title: frontmatter.title || extractTitle(content, repoPath),
          intent: frontmatter.intent,
          authority_band: frontmatter.authority_band,
          tags: frontmatter.tags,
          excerpt: extractExcerpt(content),
          content_hash: hashContent(content),
          source,
          frontmatter: Object.keys(frontmatter).length > 0 ? frontmatter : undefined,
        };

        entries.push(entry);
      }
    } catch (error) {
      console.error(`Error extracting ZIP: ${error}`);
    }

    return entries;
  }

  /**
   * Build index from a repo URL
   * @param skipCache - If true, bypass ZIP cache and fetch fresh
   */
  private async buildIndexFromRepo(
    repoUrl: string,
    source: "canon" | "baseline",
    skipCache: boolean = false
  ): Promise<IndexEntry[]> {
    const zipUrl = getZipUrl(repoUrl);
    const zipData = await this.fetchZip(zipUrl, skipCache);

    if (!zipData) {
      console.warn(`Could not fetch ZIP for ${repoUrl}`);
      return [];
    }

    const cacheKey = `zip/${getCacheKey(zipUrl)}`;
    return this.extractMarkdownFiles(zipData, source, cacheKey);
  }

  /**
   * Arbitrate between canon and baseline entries
   * Canon entries override baseline entries with same path/uri
   */
  private arbitrateEntries(
    canonEntries: IndexEntry[],
    baselineEntries: IndexEntry[]
  ): IndexEntry[] {
    const result: IndexEntry[] = [...canonEntries];
    const canonPaths = new Set(canonEntries.map((e) => e.path));
    const canonUris = new Set(canonEntries.map((e) => e.uri));

    // Add baseline entries that don't conflict with canon
    for (const entry of baselineEntries) {
      if (!canonPaths.has(entry.path) && !canonUris.has(entry.uri)) {
        result.push(entry);
      }
    }

    return result;
  }

  /**
   * Get or build the combined index.
   *
   * Content-addressed caching:
   * 1. Resolve the current commit SHA (lightweight GitHub API call)
   * 2. Use SHA as the KV cache key
   * 3. If an index exists for this exact SHA, serve it — truthful by identity
   * 4. If not, build fresh and store keyed to the SHA
   * No TTL. No staleness window.
   */
  async getIndex(canonUrl?: string): Promise<BaselineIndex> {
    const baselineRepoUrl = "https://github.com/klappy/klappy.dev";

    // Step 1: Resolve current commit SHAs (lightweight)
    const baselineSha = await this.getLatestCommitSha(baselineRepoUrl);
    const canonRef = canonUrl ? extractBranchRef(canonUrl) : undefined;
    const canonSha = canonUrl ? await this.getLatestCommitSha(canonUrl, canonRef) : undefined;

    // Step 2: Content-addressed lookup — SHA + version is the cache key.
    // Including INDEX_VERSION ensures code changes invalidate stale indexes
    // even when the repo SHA hasn't changed.
    const shaKey = `${baselineSha || "unknown"}_${canonSha || "none"}`;
    const cacheKey = `index/v${INDEX_VERSION}/${getCacheKey(canonUrl || "default")}_${shaKey}`;

    if (this.env.BASELINE_CACHE) {
      const cached = await this.env.BASELINE_CACHE.get(cacheKey, "json") as BaselineIndex | null;
      if (cached) {
        // Content-addressed cache hit: SHA matches, content is truthful
        return cached;
      }
    }

    // Step 3: No cache for this SHA — build fresh
    const baselineUrl = this.env.BASELINE_URL;
    const skipCache = true; // Always fetch fresh ZIP when building new index

    const baselineEntries = await this.buildIndexFromRepo(
      baselineUrl.includes("raw.githubusercontent.com")
        ? baselineUrl.replace("/main", "").replace("raw.githubusercontent.com", "github.com")
        : baselineRepoUrl,
      "baseline",
      skipCache
    );

    let canonEntries: IndexEntry[] = [];
    if (canonUrl) {
      canonEntries = await this.buildIndexFromRepo(canonUrl, "canon", skipCache);
    }

    // Arbitrate — canon overrides baseline
    const allEntries = this.arbitrateEntries(canonEntries, baselineEntries);

    const index: BaselineIndex = {
      version: INDEX_VERSION,
      generated_at: new Date().toISOString(),
      canon_url: canonUrl,
      baseline_url: baselineUrl,
      entries: allEntries,
      stats: {
        total: allEntries.length,
        canon: canonEntries.length,
        baseline: baselineEntries.length,
      },
      commit_sha: baselineSha || undefined,
      canon_commit_sha: canonSha || undefined,
    };

    // Store keyed to SHA (no TTL — content-addressed)
    if (this.env.BASELINE_CACHE) {
      await this.env.BASELINE_CACHE.put(cacheKey, JSON.stringify(index));
    }

    // Store commit SHAs for observability
    if (baselineSha) {
      await this.cacheCommitSha(baselineRepoUrl, baselineSha);
    }
    if (canonUrl && canonSha) {
      await this.cacheCommitSha(canonUrl, canonSha);
    }

    return index;
  }

  /**
   * Get a specific file from the baseline or canon.
   * Content-addressed: file cache is keyed to each repo's own commit SHA.
   * When canonUrl is provided, canon is tried first with the canon SHA,
   * then baseline is tried with the baseline SHA. Each repo's cache is
   * independent — a baseline file is never cached under a canon SHA.
   */
  async getFile(path: string, canonUrl?: string): Promise<string | null> {
    const baselineRepoUrl = "https://github.com/klappy/klappy.dev";

    // Resolve SHA for each repo independently
    const baselineSha = await this.getLatestCommitSha(baselineRepoUrl);

    // Build the list of repos to search, each with its own SHA
    const sources: Array<{ url: string; repoKey: string; sha: string }> = [];

    if (canonUrl) {
      const canonRef = extractBranchRef(canonUrl);
      const canonSha = await this.getLatestCommitSha(canonUrl, canonRef);
      sources.push({
        url: canonUrl,
        repoKey: getCacheKey(canonUrl),
        sha: canonSha || "unknown",
      });
    }

    sources.push({
      url: this.env.BASELINE_URL.includes("raw.githubusercontent.com")
        ? this.env.BASELINE_URL.replace("/main", "").replace("raw.githubusercontent.com", "github.com")
        : baselineRepoUrl,
      repoKey: getCacheKey("baseline"),
      sha: baselineSha || "unknown",
    });

    for (const source of sources) {
      // Content-addressed cache key: repo identity + repo SHA + file path
      const cacheKey = `file/${source.repoKey}/${source.sha}/${getCacheKey(path)}`;

      // Check R2 cache (content-addressed — if SHA matches, content is truthful)
      if (this.env.BASELINE) {
        const r2Object = await this.env.BASELINE.get(cacheKey);
        if (r2Object) {
          return await r2Object.text();
        }
      }

      // No cache for this repo+SHA+path — fetch fresh
      const zipUrl = getZipUrl(source.url);
      const zipData = await this.fetchZip(zipUrl, true);

      if (!zipData) continue;

      try {
        const unzipCacheKey = `zip/${getCacheKey(zipUrl)}`;
        const unzipped = this.getUnzipped(zipData, unzipCacheKey);

        for (const [fullPath, fileData] of Object.entries(unzipped)) {
          const pathParts = fullPath.split("/");
          const repoPath = pathParts.slice(1).join("/");

          if (repoPath === path) {
            const content = new TextDecoder().decode(fileData);

            // Store keyed to this repo's SHA (no TTL — content-addressed)
            if (this.env.BASELINE) {
              await this.env.BASELINE.put(cacheKey, content, {
                httpMetadata: { contentType: "text/markdown" },
                customMetadata: { commitSha: source.sha, fetchedAt: new Date().toISOString() },
              });
            }

            return content;
          }
        }
      } catch (error) {
        console.error(`Error extracting file from ZIP: ${error}`);
      }
    }

    return null;
  }

  /**
   * Delete all cached objects under a prefix, handling R2 pagination.
   */
  private async deleteObjectsByPrefix(prefix: string): Promise<void> {
    if (!this.env.BASELINE) {
      return;
    }

    let cursor: string | undefined;
    do {
      const listed = await this.env.BASELINE.list({ prefix, cursor });
      for (const obj of listed.objects) {
        await this.env.BASELINE.delete(obj.key);
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }

  /**
   * Delete all KV keys matching a prefix, handling pagination.
   * KV has no native prefix-delete, so we list-then-delete.
   */
  private async deleteKvByPrefix(prefix: string): Promise<void> {
    if (!this.env.BASELINE_CACHE) {
      return;
    }

    let cursor: string | undefined;
    do {
      const listed = await this.env.BASELINE_CACHE.list({ prefix, cursor });
      for (const key of listed.keys) {
        await this.env.BASELINE_CACHE.delete(key.name);
      }
      cursor = listed.list_complete ? undefined : listed.cursor;
    } while (cursor);
  }

  /**
   * Clean up stored data for a repo (storage hygiene only).
   * NOT required for correctness — content-addressed caching ensures
   * fresh content is served when the baseline SHA changes.
   */
  async invalidateCache(repoUrl?: string): Promise<void> {
    const key = getCacheKey(repoUrl || "default");
    const baselineRepoUrl = "https://github.com/klappy/klappy.dev";

    // Clear KV caches: SHA-keyed index entries + SHA tracking
    // Index keys are now SHA-suffixed (index/${base}_${shaKey}), so we
    // must list-then-delete by prefix to find all SHA variants.
    if (this.env.BASELINE_CACHE) {
      await this.deleteKvByPrefix(`index/${key}`);
      await this.deleteKvByPrefix(`sha/`);
    }

    // Clear R2 caches: ZIP + individual files (including SHA-keyed paths)
    if (this.env.BASELINE) {
      // Delete ZIP caches
      const baselineZipKey = `zip/${getCacheKey(getZipUrl(baselineRepoUrl))}`;
      await this.env.BASELINE.delete(baselineZipKey);
      if (repoUrl) {
        const canonZipKey = `zip/${getCacheKey(getZipUrl(repoUrl))}`;
        await this.env.BASELINE.delete(canonZipKey);
      }

      // Delete cached individual files (SHA-keyed subdirectories)
      const baselineFilePrefix = `file/${getCacheKey("baseline")}/`;
      await this.deleteObjectsByPrefix(baselineFilePrefix);

      if (repoUrl) {
        const canonFilePrefix = `file/${getCacheKey(repoUrl)}/`;
        await this.deleteObjectsByPrefix(canonFilePrefix);
      }
    }

    // Clear memory cache
    this.zipCache.clear();
    this.unzippedCache.clear();
    this.commitCache.clear();
  }
}
