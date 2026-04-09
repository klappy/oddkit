/**
 * Minimal BM25 search implementation for oddkit
 *
 * Indexes documents by title, path, tags, and content excerpt.
 * Uses Porter-style stemming and BM25 scoring.
 */

// BM25 parameters
const K1 = 1.2;
const B = 0.75;

// Common English stop words to filter
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "shall",
  "should", "may", "might", "must", "can", "could", "of", "in", "to",
  "for", "with", "on", "at", "by", "from", "as", "into", "through",
  "and", "but", "or", "nor", "not", "no", "so", "if", "then", "than",
  "that", "this", "it", "its", "we", "you", "he", "she", "they",
]);

/** Minimal Porter-style stemmer */
export function stem(word: string): string {
  if (word.length < 4) return word;
  return word
    .replace(/ies$/, "y")
    .replace(/ied$/, "y")
    .replace(/([^aeiou])ed$/, "$1")
    .replace(/(ing|tion|ment|ness|able|ible)$/, "")
    .replace(/s$/, "");
}

/** Tokenize and stem text, removing stop words */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/[\s\-_/]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
    .map(stem);
}

export interface BM25Doc {
  id: string;
  terms: string[];
  length: number;
  /** Original (pre-tokenization) text, used for phrase-level scoring. */
  originalText: string;
}

export interface BM25Index {
  docs: BM25Doc[];
  df: Map<string, number>;
  avgdl: number;
  N: number;
}

/** Build BM25 index from {id, text} pairs */
export function buildBM25Index(
  documents: Array<{ id: string; text: string }>,
): BM25Index {
  const docs: BM25Doc[] = [];
  const df = new Map<string, number>();
  let totalLength = 0;

  for (const doc of documents) {
    const terms = tokenize(doc.text);
    docs.push({ id: doc.id, terms, length: terms.length, originalText: doc.text });
    totalLength += terms.length;

    const seen = new Set<string>();
    for (const term of terms) {
      if (!seen.has(term)) {
        seen.add(term);
        df.set(term, (df.get(term) || 0) + 1);
      }
    }
  }

  return {
    docs,
    df,
    avgdl: documents.length > 0 ? totalLength / documents.length : 0,
    N: documents.length,
  };
}

// Phrase boost constants — supplement BM25, never replace it.
// Exact: full query string found as substring in doc text.
// Partial: any consecutive two-word query bigram found in doc text.
const PHRASE_BOOST_EXACT = 5.0;
const PHRASE_BOOST_PARTIAL = 2.0;

/** Search BM25 index, return sorted {id, score} pairs */
export function searchBM25(
  index: BM25Index,
  query: string,
  limit: number = 5,
): Array<{ id: string; score: number }> {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return [];

  // Pre-compute phrase matching inputs once, outside the per-doc loop.
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.replace(/[^\w\s-]/g, " ").split(/[\s\-_/]+/).filter((w) => w.length > 1 && !STOP_WORDS.has(w));

  const scores: Array<{ id: string; score: number }> = [];

  for (const doc of index.docs) {
    let score = 0;

    // Count term frequencies in this doc
    const tf = new Map<string, number>();
    for (const term of doc.terms) {
      tf.set(term, (tf.get(term) || 0) + 1);
    }

    for (const qterm of queryTerms) {
      const n = index.df.get(qterm) || 0;
      if (n === 0) continue;

      // IDF: ln((N - n + 0.5) / (n + 0.5) + 1)
      const idf = Math.log((index.N - n + 0.5) / (n + 0.5) + 1);

      // TF normalization with BM25
      const freq = tf.get(qterm) || 0;
      const tfNorm =
        (freq * (K1 + 1)) /
        (freq + K1 * (1 - B + (B * doc.length) / index.avgdl));

      score += idf * tfNorm;
    }

    // Phrase boost: supplement BM25 — never replace it.
    // Only apply when the document already has genuine BM25 relevance.
    if (score > 0) {
      const docLower = doc.originalText.toLowerCase();
      if (docLower.includes(queryLower)) {
        score += PHRASE_BOOST_EXACT;
      } else if (queryWords.length >= 2) {
        for (let i = 0; i < queryWords.length - 1; i++) {
          const bigram = queryWords[i] + " " + queryWords[i + 1];
          if (docLower.includes(bigram)) {
            score += PHRASE_BOOST_PARTIAL;
            break;
          }
        }
      }
    }

    if (score > 0) scores.push({ id: doc.id, score });
  }

  return scores.sort((a, b) => b.score - a.score).slice(0, limit);
}
