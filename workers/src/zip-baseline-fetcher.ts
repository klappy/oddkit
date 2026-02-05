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
  BASELINE_R2?: R2Bucket;
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

export class ZipBaselineFetcher {
  private env: Env;
  private zipCache: Map<string, Uint8Array> = new Map();

  constructor(env: Env) {
    this.env = env;
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
    if (this.env.BASELINE_R2) {
      const r2Object = await this.env.BASELINE_R2.get(cacheKey);
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
      if (this.env.BASELINE_R2) {
        await this.env.BASELINE_R2.put(cacheKey, data, {
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
   */
  async getIndex(canonUrl?: string): Promise<BaselineIndex> {
    const cacheKey = `index/${getCacheKey(canonUrl || "default")}`;

    // Check KV cache first
    if (this.env.BASELINE_CACHE) {
      const cached = await this.env.BASELINE_CACHE.get(cacheKey, "json");
      if (cached) {
        return cached as BaselineIndex;
      }
    }

    // Build index from repos
    const baselineUrl = this.env.BASELINE_URL;

    // Always fetch baseline (klappy.dev)
    const baselineEntries = await this.buildIndexFromRepo(
      baselineUrl.includes("raw.githubusercontent.com")
        ? baselineUrl.replace("/main", "").replace("raw.githubusercontent.com", "github.com")
        : "https://github.com/klappy/klappy.dev",
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
    };

    // Cache in KV
    if (this.env.BASELINE_CACHE) {
      await this.env.BASELINE_CACHE.put(cacheKey, JSON.stringify(index), {
        expirationTtl: INDEX_TTL,
      });
    }

    return index;
  }

  /**
   * Get a specific file from the baseline or canon
   */
  async getFile(path: string, canonUrl?: string): Promise<string | null> {
    const cacheKey = `file/${getCacheKey(canonUrl || "baseline")}/${getCacheKey(path)}`;

    // Check R2 cache
    if (this.env.BASELINE_R2) {
      const r2Object = await this.env.BASELINE_R2.get(cacheKey);
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
            if (this.env.BASELINE_R2) {
              await this.env.BASELINE_R2.put(cacheKey, content, {
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
