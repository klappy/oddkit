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
 * Intent hierarchy values (per canon/weighted-relevance-and-arbitration.md)
 * Higher = more durable, more authority
 */
export const INTENT_WEIGHTS = {
  workaround: 0.6,
  experiment: 0.7,
  operational: 1.0,
  pattern: 1.3,
  promoted: 1.5,
};

/**
 * Evidence strength multipliers (per canon/weighted-relevance-and-arbitration.md)
 */
export const EVIDENCE_WEIGHTS = {
  none: 0.8,
  weak: 0.9,
  medium: 1.0,
  strong: 1.2,
};

/**
 * Score a document against a query
 * Returns { score, signals } where signals explain what mattered
 * Per canon/weighted-relevance-and-arbitration.md: scores recommend, they do not decide
 */
export function scoreDocument(doc, queryTokens) {
  let baseScore = 0;
  const signals = {
    title_match: 0,
    subtitle_match: 0,
    tag_match: 0,
    heading_match: 0,
    content_match: 0,
    authority_multiplier: 1.0,
    intent_multiplier: 1.0,
    evidence_multiplier: 1.0,
    origin_multiplier: 1.0,
  };

  // Title match (high weight)
  if (doc.title) {
    const titleTokens = tokenize(doc.title);
    signals.title_match = queryTokens.filter((q) => titleTokens.includes(q)).length;
    baseScore += signals.title_match * 10;
  }

  // Subtitle match (medium weight)
  if (doc.subtitle) {
    const subtitleTokens = tokenize(doc.subtitle);
    signals.subtitle_match = queryTokens.filter((q) => subtitleTokens.includes(q)).length;
    baseScore += signals.subtitle_match * 5;
  }

  // Tags match (medium weight)
  if (doc.tags && doc.tags.length > 0) {
    const tagTokens = doc.tags.flatMap((t) => tokenize(t));
    signals.tag_match = queryTokens.filter((q) => tagTokens.includes(q)).length;
    baseScore += signals.tag_match * 5;
  }

  // Headings match (medium weight)
  if (doc.headings && doc.headings.length > 0) {
    for (const h of doc.headings) {
      const headingTokens = tokenize(h.text);
      const headingMatches = queryTokens.filter((q) => headingTokens.includes(q)).length;
      signals.heading_match += headingMatches;
      baseScore += headingMatches * 3;
    }
  }

  // Content preview match (low weight)
  if (doc.contentPreview) {
    const contentTokens = tokenize(doc.contentPreview);
    signals.content_match = queryTokens.filter((q) => contentTokens.includes(q)).length;
    baseScore += signals.content_match * 1;
  }

  // Authority band multiplier
  if (doc.authority_band === "governing") {
    signals.authority_multiplier = 1.5;
  } else if (doc.authority_band === "operational") {
    signals.authority_multiplier = 1.2;
  }

  // Intent multiplier (per canon/weighted-relevance-and-arbitration.md)
  signals.intent_multiplier = INTENT_WEIGHTS[doc.intent] || 1.0;

  // Evidence multiplier (per canon/weighted-relevance-and-arbitration.md)
  signals.evidence_multiplier = EVIDENCE_WEIGHTS[doc.evidence] || 1.0;

  // Origin multiplier (local preferred over baseline)
  signals.origin_multiplier = doc.origin === "local" ? 1.1 : 1.0;

  // Final score
  const finalScore =
    baseScore *
    signals.authority_multiplier *
    signals.intent_multiplier *
    signals.evidence_multiplier *
    signals.origin_multiplier;

  return { score: finalScore, signals };
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
