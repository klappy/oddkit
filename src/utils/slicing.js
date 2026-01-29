import { readFileSync } from "fs";
import matter from "gray-matter";

// Quote length constraints (in words)
export const MIN_QUOTE_WORDS = 8;
export const MAX_QUOTE_WORDS = 40;

/**
 * Count words in a string
 */
export function countWords(text) {
  if (!text) return 0;
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/**
 * Extract a quote from a document at a specific heading
 * Returns { quote, wordCount, truncated } or null
 */
export function extractQuote(doc, heading) {
  try {
    const raw = readFileSync(doc.absolutePath, "utf-8");
    const { content } = matter(raw);
    const lines = content.split("\n");

    // Get the region for this heading
    const startLine = heading.startLine;
    const endLine = heading.endLine;

    // Skip the heading line itself, get content
    const regionLines = lines.slice(startLine + 1, endLine + 1);
    const regionText = regionLines.join(" ").trim();

    // Clean up and extract quote
    const cleaned = regionText
      .replace(/\s+/g, " ")
      .replace(/[#*_`]/g, "")
      .trim();

    // Extract words
    const words = cleaned.split(/\s+/).filter((w) => w.length > 0);

    if (words.length === 0) {
      return null;
    }

    // Find the best starting point (prefer sentences with MUST, SHOULD, etc.)
    let startIdx = 0;
    for (let i = 0; i < words.length; i++) {
      const word = words[i].toUpperCase();
      if (word === "MUST" || word === "SHOULD" || word === "SHALL" || word === "REQUIRES") {
        startIdx = Math.max(0, i - 2);
        break;
      }
    }

    // Extract 8-40 words
    let quoteWords = words.slice(startIdx, startIdx + MAX_QUOTE_WORDS);
    let truncated = words.length > startIdx + MAX_QUOTE_WORDS;

    if (quoteWords.length < MIN_QUOTE_WORDS && words.length >= MIN_QUOTE_WORDS) {
      // Not enough words from preferred start, try from beginning
      quoteWords = words.slice(0, MAX_QUOTE_WORDS);
      truncated = words.length > MAX_QUOTE_WORDS;
    }

    const quote = quoteWords.join(" ");
    const wordCount = quoteWords.length;

    return { quote, wordCount, truncated };
  } catch (err) {
    return null;
  }
}

/**
 * Format citation as path#Heading
 */
export function formatCitation(doc, heading) {
  return `${doc.path}#${heading.text}`;
}
