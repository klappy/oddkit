import { readFileSync, existsSync } from "fs";
import { join } from "path";
import matter from "gray-matter";
import { ensureBaselineRepo } from "../baseline/ensureBaselineRepo.js";
import { countWords } from "../utils/slicing.js";

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
 * Strip fenced code blocks from content
 */
function stripCodeBlocks(content) {
  if (!content) return "";
  return content.replace(/```[\s\S]*?```/g, "");
}

/**
 * Read excerpt from a markdown file
 *
 * @param {Object} options
 * @param {string} options.repo_root - Repository root path
 * @param {string} options.origin - "local" or "baseline"
 * @param {string} options.path - File path relative to repo root
 * @param {string} options.anchor - Optional heading anchor (e.g., "Epistemic Challenge")
 * @param {number} options.max_words - Maximum words in excerpt (default: 25)
 * @returns {Object} { excerpt, citation } or null if file not found
 */
export async function readExcerpt(options) {
  const { repo_root, origin, path, anchor, max_words = 25 } = options;

  let filePath;
  if (origin === "local") {
    filePath = join(repo_root, path);
  } else if (origin === "baseline") {
    const baseline = await ensureBaselineRepo();
    if (!baseline.root) {
      return null; // Baseline unavailable
    }
    filePath = join(baseline.root, path);
  } else {
    return null; // Unknown origin
  }

  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const raw = readFileSync(filePath, "utf-8");
    const { content } = matter(raw);

    // Strip code blocks for excerpting
    const contentWithoutCode = stripCodeBlocks(content);
    const lines = contentWithoutCode.split("\n");

    let excerptText = contentWithoutCode;

    // If anchor exists, extract section under that heading
    if (anchor) {
      const headings = extractHeadings(content);
      const targetHeading = headings.find((h) => h.text.toLowerCase() === anchor.toLowerCase());

      if (targetHeading) {
        const startLine = targetHeading.startLine + 1; // Skip heading line
        const endLine = targetHeading.endLine;
        const sectionLines = lines.slice(startLine, endLine + 1);
        excerptText = sectionLines.join(" ").trim();
      }
    }

    // Extract up to max_words words
    const words = excerptText
      .replace(/\s+/g, " ")
      .replace(/[#*_`]/g, "")
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0);

    if (words.length === 0) {
      return null;
    }

    const excerptWords = words.slice(0, max_words);
    const excerpt = excerptWords.join(" ");

    // Build citation
    const citation = anchor ? `${path}#${anchor}` : path;

    return { excerpt, citation };
  } catch (err) {
    return null;
  }
}
