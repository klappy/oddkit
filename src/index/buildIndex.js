import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { join, relative, dirname } from 'path';
import { homedir } from 'os';
import fg from 'fast-glob';
import matter from 'gray-matter';

// Default include patterns
const INCLUDE_PATTERNS = ['canon/**/*.md', 'odd/**/*.md', 'docs/**/*.md'];

// Default exclude patterns
const EXCLUDE_PATTERNS = ['**/node_modules/**', '**/public/**', '**/.git/**', '**/.oddkit/**'];

/**
 * Extract headings with line numbers from content
 */
function extractHeadings(content) {
  const lines = content.split('\n');
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
 */
async function indexRoot(rootPath, origin) {
  const docs = [];

  // Find all matching files
  const files = await fg(INCLUDE_PATTERNS, {
    cwd: rootPath,
    ignore: EXCLUDE_PATTERNS,
    absolute: false,
  });

  for (const filePath of files) {
    const absolutePath = join(rootPath, filePath);

    try {
      const raw = readFileSync(absolutePath, 'utf-8');
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
        headings,
        contentLength: content.length,
        contentPreview: content.slice(0, 500),
      });
    } catch (err) {
      // Skip files that can't be read
      console.error(`Warning: Could not index ${filePath}: ${err.message}`);
    }
  }

  return docs;
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
  if (filePath.startsWith('canon/') || filePath.startsWith('odd/')) {
    return 'governing';
  }
  if (filePath.startsWith('docs/')) {
    return 'operational';
  }
  return 'non-governing';
}

/**
 * Build complete index for local repo + baseline
 */
export async function buildIndex(repoRoot, baselineRoot = null) {
  const localDocs = await indexRoot(repoRoot, 'local');

  let baselineDocs = [];
  if (baselineRoot) {
    baselineDocs = await indexRoot(baselineRoot, 'baseline');
  }

  const allDocs = [...localDocs, ...baselineDocs];

  const index = {
    version: '1.0.0',
    generated: new Date().toISOString(),
    stats: {
      total: allDocs.length,
      local: localDocs.length,
      baseline: baselineDocs.length,
      byAuthority: {
        governing: allDocs.filter((d) => d.authority_band === 'governing').length,
        operational: allDocs.filter((d) => d.authority_band === 'operational').length,
        'non-governing': allDocs.filter((d) => d.authority_band === 'non-governing').length,
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
  const indexDir = join(repoRoot, '.oddkit');
  if (!existsSync(indexDir)) {
    mkdirSync(indexDir, { recursive: true });
  }

  const indexPath = join(indexDir, 'index.json');
  writeFileSync(indexPath, JSON.stringify(index, null, 2));

  return indexPath;
}

/**
 * Save baseline index to cache
 */
export function saveBaselineIndex(index, ref) {
  const cacheDir = join(homedir(), '.oddkit', 'cache', 'indexes');
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }

  const indexPath = join(cacheDir, `klappy.dev-${ref.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  writeFileSync(indexPath, JSON.stringify(index, null, 2));

  return indexPath;
}

/**
 * Load index from disk if it exists and is fresh
 */
export function loadIndex(repoRoot) {
  const indexPath = join(repoRoot, '.oddkit', 'index.json');

  if (!existsSync(indexPath)) {
    return null;
  }

  try {
    const raw = readFileSync(indexPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Load baseline index from cache
 */
export function loadBaselineIndex(ref) {
  const indexPath = join(
    homedir(),
    '.oddkit',
    'cache',
    'indexes',
    `klappy.dev-${ref.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`
  );

  if (!existsSync(indexPath)) {
    return null;
  }

  try {
    const raw = readFileSync(indexPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
