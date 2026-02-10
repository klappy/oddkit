/**
 * Minimal BM25 search implementation for oddkit (Node/stdio server)
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
export function stem(word) {
  if (word.length < 4) return word;
  return word
    .replace(/ies$/, "y")
    .replace(/ied$/, "y")
    .replace(/([^aeiou])ed$/, "$1")
    .replace(/(ing|tion|ment|ness|able|ible)$/, "")
    .replace(/s$/, "");
}

/** Tokenize and stem text, removing stop words */
export function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/[\s\-_/]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
    .map(stem);
}

/** Build BM25 index from {id, text} pairs */
export function buildBM25Index(documents) {
  const docs = [];
  const df = new Map();
  let totalLength = 0;

  for (const doc of documents) {
    const terms = tokenize(doc.text);
    docs.push({ id: doc.id, terms, length: terms.length });
    totalLength += terms.length;

    const seen = new Set();
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

/** Search BM25 index, return sorted {id, score} pairs */
export function searchBM25(index, query, limit = 5) {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return [];

  const scores = [];

  for (const doc of index.docs) {
    let score = 0;

    const tf = new Map();
    for (const term of doc.terms) {
      tf.set(term, (tf.get(term) || 0) + 1);
    }

    for (const qterm of queryTerms) {
      const n = index.df.get(qterm) || 0;
      if (n === 0) continue;

      const idf = Math.log((index.N - n + 0.5) / (n + 0.5) + 1);
      const freq = tf.get(qterm) || 0;
      const tfNorm =
        (freq * (K1 + 1)) /
        (freq + K1 * (1 - B + (B * doc.length) / index.avgdl));

      score += idf * tfNorm;
    }

    if (score > 0) scores.push({ id: doc.id, score });
  }

  return scores.sort((a, b) => b.score - a.score).slice(0, limit);
}
