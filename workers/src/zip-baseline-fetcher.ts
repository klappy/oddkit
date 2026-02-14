/**
 * ZipBaselineFetcher - Content-addressed caching for baseline repos
 *
 * Architecture:
 * - Resolves current commit SHA via lightweight GitHub API call
 * - Uses SHA as cache key — if SHA matches, content is truthful by identity
 * - Fetches entire repo as ZIP from GitHub when SHA changes
 * - Extracts files lazily using fflate
 * - Caches in R2 keyed to SHA for fast subsequent access
 * - Supports canon repo overrides with klappy.dev fallback
 * - No TTL. No staleness window. No manual flush for correctness.
 */

import { unzipSync } from "fflate";

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
}

// ──────────────────────────────────────────────────────────────────────────────
// Content-addressed caching: No TTLs. All storage is keyed to commit SHA.
// When the SHA changes, old content is ignored and fresh content is fetched.
// No staleness window. No manual flush for correctness.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Parse YAML frontmatter from markdown content
 */
function parseFrontmatter(content: string): FrontmatterResult {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const yaml = match[1];
  const result: FrontmatterResult = {};

  // Simple YAML parsing for common fields
  const titleMatch = yaml.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  if (titleMatch) result.title = titleMatch[1];

  const intentMatch = yaml.match(/^intent:\s*["']?(.+?)["']?\s*$/m);
  if (intentMatch) result.intent = intentMatch[1];

  const bandMatch = yaml.match(/^authority_band:\s*["']?(.+?)["']?\s*$/m);
  if (bandMatch) result.authority_band = bandMatch[1];

  const uriMatch = yaml.match(/^uri:\s*["']?(.+?)["']?\s*$/m);
  if (uriMatch) result.uri = uriMatch[1];

  const tagsMatch = yaml.match(/^tags:\s*\[(.+?)\]/m);
  if (tagsMatch) {
    result.tags = tagsMatch[1].split(",").map((t) => t.trim().replace(/["']/g, ""));
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
 * Convert GitHub repo URL to ZIP download URL
 */
function getZipUrl(repoUrl: string, ref: string = "main"): string {
  // Handle various URL formats
  // https://github.com/owner/repo -> https://github.com/owner/repo/archive/main.zip
  // https://raw.githubusercontent.com/owner/repo/main -> https://github.com/owner/repo/archive/main.zip

  let cleanUrl = repoUrl
    .replace(/\.git$/, "")
    .replace(/\/$/, "");

  if (cleanUrl.includes("raw.githubusercontent.com")) {
    // Convert raw URL to repo URL
    const parts = cleanUrl.replace("https://raw.githubusercontent.com/", "").split("/");
    cleanUrl = `https://github.com/${parts[0]}/${parts[1]}`;
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
   */
  private getUnzipped(zipData: Uint8Array, cacheKey: string): Record<string, Uint8Array> {
    const existing = this.unzippedCache.get(cacheKey);
    if (existing) {
      return existing;
    }
    const unzipped = unzipSync(zipData, {
      filter: (file) => file.name.endsWith(".md"),
    });
    this.unzippedCache.set(cacheKey, unzipped);
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
      const unzipped = this.getUnzipped(zipData, zipCacheKey);

      for (const [fullPath, fileData] of Object.entries(unzipped)) {
        // Skip non-markdown files
        if (!fullPath.endsWith(".md")) continue;

        // Skip excluded directories
        if (
          fullPath.includes("node_modules/") ||
          fullPath.includes(".git/") ||
          fullPath.includes(".oddkit/")
        ) continue;

        // Only include canon/, odd/, docs/, writings/ directories
        const pathParts = fullPath.split("/");
        // Remove repo-branch prefix (e.g., "klappy.dev-main/")
        const repoPath = pathParts.slice(1).join("/");

        if (
          !repoPath.startsWith("canon/") &&
          !repoPath.startsWith("odd/") &&
          !repoPath.startsWith("docs/") &&
          !repoPath.startsWith("writings/")
        ) continue;

        // Decode file content
        const content = new TextDecoder().decode(fileData);
        const frontmatter = parseFrontmatter(content);

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
    const canonSha = canonUrl ? await this.getLatestCommitSha(canonUrl) : undefined;

    // Step 2: Content-addressed lookup — SHA + schema version is the cache key
    // Including INDEX_VERSION ensures schema changes (e.g. adding writings/) invalidate old caches.
    const INDEX_VERSION = "2.0";
    const shaKey = `${baselineSha || "unknown"}_${canonSha || "none"}_v${INDEX_VERSION}`;
    const cacheKey = `index/${getCacheKey(canonUrl || "default")}_${shaKey}`;

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
      version: "2.0",
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
      const canonSha = await this.getLatestCommitSha(canonUrl);
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
