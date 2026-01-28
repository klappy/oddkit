/**
 * Tokenize text for scoring
 */
export function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

/**
 * Score a document against a query
 * Returns a score where higher = more relevant
 */
export function scoreDocument(doc, queryTokens) {
  let score = 0;

  // Title match (high weight)
  if (doc.title) {
    const titleTokens = tokenize(doc.title);
    const titleMatches = queryTokens.filter((q) => titleTokens.includes(q)).length;
    score += titleMatches * 10;
  }

  // Subtitle match (medium weight)
  if (doc.subtitle) {
    const subtitleTokens = tokenize(doc.subtitle);
    const subtitleMatches = queryTokens.filter((q) => subtitleTokens.includes(q)).length;
    score += subtitleMatches * 5;
  }

  // Tags match (medium weight)
  if (doc.tags && doc.tags.length > 0) {
    const tagTokens = doc.tags.flatMap((t) => tokenize(t));
    const tagMatches = queryTokens.filter((q) => tagTokens.includes(q)).length;
    score += tagMatches * 5;
  }

  // Headings match (medium weight)
  if (doc.headings && doc.headings.length > 0) {
    for (const h of doc.headings) {
      const headingTokens = tokenize(h.text);
      const headingMatches = queryTokens.filter((q) => headingTokens.includes(q)).length;
      score += headingMatches * 3;
    }
  }

  // Content preview match (low weight)
  if (doc.contentPreview) {
    const contentTokens = tokenize(doc.contentPreview);
    const contentMatches = queryTokens.filter((q) => contentTokens.includes(q)).length;
    score += contentMatches * 1;
  }

  // Authority band bias
  if (doc.authority_band === "governing") {
    score *= 1.5;
  } else if (doc.authority_band === "operational") {
    score *= 1.2;
  }

  return score;
}

/**
 * Find the best heading match in a document for a query
 */
export function findBestHeading(doc, queryTokens) {
  if (!doc.headings || doc.headings.length === 0) {
    return null;
  }

  let bestHeading = null;
  let bestScore = 0;

  for (const h of doc.headings) {
    const headingTokens = tokenize(h.text);
    const matches = queryTokens.filter((q) => headingTokens.includes(q)).length;

    if (matches > bestScore) {
      bestScore = matches;
      bestHeading = h;
    }
  }

  // If no query matches, return first h2+ heading
  if (!bestHeading) {
    bestHeading = doc.headings.find((h) => h.level >= 2) || doc.headings[0];
  }

  return bestHeading;
}
