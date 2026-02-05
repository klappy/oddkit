/**
 * ZipBaselineFetcher - Tiered caching for baseline repos
 *
 * Architecture inspired by translation-helps-mcp:
 * - Fetches entire repo as ZIP from GitHub
 * - Extracts files lazily using fflate
 * - Caches in R2 for fast subsequent access
 * - Supports canon repo overrides with klappy.dev fallback
 */

import { unzipSync } from "fflate";

export interface Env {
  BASELINE_URL: string;
  ODDKIT_VERSION: string;
  BASELINE_CACHE?: KVNamespace;
  BASELINE?: R2Bucket;
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

// Cache TTLs
const INDEX_TTL = 300; // 5 minutes for index
const FILE_TTL = 3600; // 1 hour for individual files
const ZIP_TTL = 86400; // 24 hours for ZIP files

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
  private commitCache: Map<string, string> = new Map();

  constructor(env: Env) {
    this.env = env;
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
   * Store commit SHA in cache
   */
  private async cacheCommitSha(repoUrl: string, sha: string): Promise<void> {
    const cacheKey = `sha/${getCacheKey(repoUrl)}`;
    if (this.env.BASELINE_CACHE) {
      // Cache SHA for longer than index (1 hour) since it's cheap to check
      await this.env.BASELINE_CACHE.put(cacheKey, sha, {
        expirationTtl: 3600,
      });
    }
  }

  /**
   * Fetch and cache a ZIP file
   */
  private async fetchZip(url: string): Promise<Uint8Array | null> {
    const cacheKey = `zip/${getCacheKey(url)}`;

    // Check memory cache first
    if (this.zipCache.has(cacheKey)) {
      return this.zipCache.get(cacheKey)!;
    }

    // Check R2 cache
    if (this.env.BASELINE) {
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

      // Cache in R2
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
    source: "canon" | "baseline"
  ): IndexEntry[] {
    const entries: IndexEntry[] = [];

    try {
      // Lazy unzip - only decompress file listing first
      const unzipped = unzipSync(zipData);

      for (const [fullPath, fileData] of Object.entries(unzipped)) {
        // Skip non-markdown files
        if (!fullPath.endsWith(".md")) continue;

        // Skip excluded directories
        if (
          fullPath.includes("node_modules/") ||
          fullPath.includes(".git/") ||
          fullPath.includes(".oddkit/")
        ) continue;

        // Only include canon/, odd/, docs/ directories
        const pathParts = fullPath.split("/");
        // Remove repo-branch prefix (e.g., "klappy.dev-main/")
        const repoPath = pathParts.slice(1).join("/");

        if (
          !repoPath.startsWith("canon/") &&
          !repoPath.startsWith("odd/") &&
          !repoPath.startsWith("docs/")
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
   */
  private async buildIndexFromRepo(
    repoUrl: string,
    source: "canon" | "baseline"
  ): Promise<IndexEntry[]> {
    const zipUrl = getZipUrl(repoUrl);
    const zipData = await this.fetchZip(zipUrl);

    if (!zipData) {
      console.warn(`Could not fetch ZIP for ${repoUrl}`);
      return [];
    }

    return this.extractMarkdownFiles(zipData, source);
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
   * Get or build the combined index
   * Uses efficient change detection: checks commit SHA before re-fetching
   */
  async getIndex(canonUrl?: string): Promise<BaselineIndex> {
    const cacheKey = `index/${getCacheKey(canonUrl || "default")}`;
    const baselineRepoUrl = "https://github.com/klappy/klappy.dev";

    // Check KV cache first
    if (this.env.BASELINE_CACHE) {
      const cached = await this.env.BASELINE_CACHE.get(cacheKey, "json") as BaselineIndex | null;
      if (cached) {
        // Cache hit - but check if source repos have changed
        // This is lightweight (~200 bytes) compared to re-fetching ZIPs
        const baselineCheck = await this.checkForChanges(baselineRepoUrl);
        const canonCheck = canonUrl ? await this.checkForChanges(canonUrl) : { changed: false };

        // Compare cached SHAs with current
        const baselineUnchanged = !baselineCheck.changed ||
          (baselineCheck.current_sha && cached.commit_sha === baselineCheck.current_sha);
        const canonUnchanged = !canonCheck.changed ||
          (canonCheck.current_sha && cached.canon_commit_sha === canonCheck.current_sha);

        if (baselineUnchanged && canonUnchanged) {
          // No changes detected - return cached index
          return cached;
        }
        // Changes detected - fall through to rebuild
        console.log(`Changes detected: baseline=${!baselineUnchanged}, canon=${!canonUnchanged}`);
      }
    }

    // Build index from repos
    const baselineUrl = this.env.BASELINE_URL;

    // Get current commit SHAs for tracking
    const baselineSha = await this.getLatestCommitSha(baselineRepoUrl);
    const canonSha = canonUrl ? await this.getLatestCommitSha(canonUrl) : undefined;

    // Always fetch baseline (klappy.dev)
    const baselineEntries = await this.buildIndexFromRepo(
      baselineUrl.includes("raw.githubusercontent.com")
        ? baselineUrl.replace("/main", "").replace("raw.githubusercontent.com", "github.com")
        : baselineRepoUrl,
      "baseline"
    );

    // Fetch canon if provided
    let canonEntries: IndexEntry[] = [];
    if (canonUrl) {
      canonEntries = await this.buildIndexFromRepo(canonUrl, "canon");
    }

    // Arbitrate - canon overrides baseline
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

    // Cache in KV
    if (this.env.BASELINE_CACHE) {
      await this.env.BASELINE_CACHE.put(cacheKey, JSON.stringify(index), {
        expirationTtl: INDEX_TTL,
      });
    }

    // Cache commit SHAs for future change checks
    if (baselineSha) {
      await this.cacheCommitSha(baselineRepoUrl, baselineSha);
    }
    if (canonUrl && canonSha) {
      await this.cacheCommitSha(canonUrl, canonSha);
    }

    return index;
  }

  /**
   * Get a specific file from the baseline or canon
   */
  async getFile(path: string, canonUrl?: string): Promise<string | null> {
    const cacheKey = `file/${getCacheKey(canonUrl || "baseline")}/${getCacheKey(path)}`;

    // Check R2 cache
    if (this.env.BASELINE) {
      const r2Object = await this.env.BASELINE.get(cacheKey);
      if (r2Object) {
        return await r2Object.text();
      }
    }

    // Try to fetch from canon first, then baseline
    const urls = canonUrl
      ? [canonUrl, this.env.BASELINE_URL]
      : [this.env.BASELINE_URL];

    for (const repoUrl of urls) {
      const zipUrl = getZipUrl(
        repoUrl.includes("raw.githubusercontent.com")
          ? repoUrl.replace("/main", "").replace("raw.githubusercontent.com", "github.com")
          : repoUrl
      );
      const zipData = await this.fetchZip(zipUrl);

      if (!zipData) continue;

      try {
        const unzipped = unzipSync(zipData);

        // Find the file (accounting for repo-branch prefix)
        for (const [fullPath, fileData] of Object.entries(unzipped)) {
          const pathParts = fullPath.split("/");
          const repoPath = pathParts.slice(1).join("/");

          if (repoPath === path) {
            const content = new TextDecoder().decode(fileData);

            // Cache in R2
            if (this.env.BASELINE) {
              await this.env.BASELINE.put(cacheKey, content, {
                httpMetadata: { contentType: "text/markdown" },
                customMetadata: { fetchedAt: new Date().toISOString() },
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
   * Invalidate cache for a repo
   */
  async invalidateCache(repoUrl?: string): Promise<void> {
    const key = getCacheKey(repoUrl || "default");

    // Clear KV cache
    if (this.env.BASELINE_CACHE) {
      await this.env.BASELINE_CACHE.delete(`index/${key}`);
    }

    // Clear memory cache
    this.zipCache.clear();

    // Note: R2 files have longer TTL and will expire naturally
  }
}
