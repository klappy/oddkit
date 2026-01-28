import { readFileSync } from "fs";
import matter from "gray-matter";

/**
 * Extract a quote from a document at a specific heading
 * Returns a quote of 8-40 words
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

    // Extract 8-40 words
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
    const minWords = 8;
    const maxWords = 40;
    const quoteWords = words.slice(startIdx, startIdx + maxWords);

    if (quoteWords.length < minWords && words.length >= minWords) {
      // Not enough words from preferred start, try from beginning
      return words.slice(0, maxWords).join(" ");
    }

    return quoteWords.join(" ");
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
