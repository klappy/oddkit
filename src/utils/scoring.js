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
 * Epistemic mode bias configuration
 * Per CHARTER.md: oddkit adapts retrieval based on caller-provided epistemic context.
 * These are soft boosts (multipliers), not hard filters.
 *
 * Tags and doc properties that get boosted per mode:
 * - exploration: overview, getting-started, principles, quickstart, foundational
 * - planning: constraints, dod, decisions, boundaries, governing
 * - execution: implementation, how-to, commands, operational
 */
const EPISTEMIC_MODE_BOOSTS = {
  exploration: {
    tags: [
      "overview",
      "getting-started",
      "principles",
      "quickstart",
      "start",
      "introduction",
      "foundational",
    ],
    authority_bands: [], // No specific authority bias for exploration
    intents: [], // No specific intent bias
    multiplier: 1.2, // 20% boost for matching docs
  },
  planning: {
    tags: [
      "constraints",
      "dod",
      "definition-of-done",
      "decisions",
      "boundaries",
      "requirements",
      "rules",
    ],
    authority_bands: ["governing"],
    intents: ["promoted", "pattern"],
    multiplier: 1.25, // 25% boost for matching docs
  },
  execution: {
    tags: ["implementation", "how-to", "commands", "operational", "playbook", "guide"],
    authority_bands: ["operational"],
    intents: ["operational"],
    multiplier: 1.15, // 15% boost for matching docs
  },
};

/**
 * Compute epistemic bias multiplier for a document
 * Per CHARTER.md: bias is soft (multiplier), observable (returned in signals), and never authoritarian
 *
 * @param {Object} doc - The document being scored
 * @param {Object} epistemic - Epistemic context { mode_ref, confidence }
 * @returns {Object} { multiplier, reason, mode }
 */
export function computeEpistemicBias(doc, epistemic) {
  // No epistemic context = no bias (neutral)
  if (!epistemic || !epistemic.mode_ref) {
    return { multiplier: 1.0, reason: null, mode: null };
  }

  // Extract mode from mode_ref URI (e.g., "klappy://canon/epistemic-modes#exploration" -> "exploration")
  const modeMatch = epistemic.mode_ref.match(/#(\w+)$/);
  const mode = modeMatch ? modeMatch[1].toLowerCase() : null;

  if (!mode || !EPISTEMIC_MODE_BOOSTS[mode]) {
    return { multiplier: 1.0, reason: "unknown_mode", mode };
  }

  const config = EPISTEMIC_MODE_BOOSTS[mode];
  const docTags = (doc.tags || []).map((t) => String(t).toLowerCase().trim());

  // Check if doc matches any boost criteria
  const matchedCriteria = [];

  // Tag match
  const tagMatch = config.tags.some((t) => docTags.includes(t));
  if (tagMatch) {
    matchedCriteria.push("tag");
  }

  // Authority band match
  const authorityMatch = config.authority_bands.includes(doc.authority_band);
  if (authorityMatch) {
    matchedCriteria.push("authority");
  }

  // Intent match
  const intentMatch = config.intents.includes(doc.intent);
  if (intentMatch) {
    matchedCriteria.push("intent");
  }

  if (matchedCriteria.length > 0) {
    // Apply boost with slight scaling for multiple matches
    const multiplier = config.multiplier + (matchedCriteria.length - 1) * 0.05;
    return {
      multiplier: Math.min(multiplier, 1.4), // Cap at 40% boost
      reason: matchedCriteria.join("+"),
      mode,
    };
  }

  return { multiplier: 1.0, reason: null, mode };
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
 * Per CHARTER.md: epistemic bias is soft and observable
 *
 * @param {Object} doc - Document to score
 * @param {string[]} queryTokens - Tokenized query
 * @param {Object} [epistemic] - Optional epistemic context { mode_ref, confidence }
 */
export function scoreDocument(doc, queryTokens, epistemic = null) {
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
    epistemic_multiplier: 1.0,
    epistemic_mode: null,
    epistemic_reason: null,
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

  // Epistemic bias multiplier (per CHARTER.md: soft, observable, never authoritarian)
  if (epistemic) {
    const bias = computeEpistemicBias(doc, epistemic);
    signals.epistemic_multiplier = bias.multiplier;
    signals.epistemic_mode = bias.mode;
    signals.epistemic_reason = bias.reason;
  }

  // Final score
  const finalScore =
    baseScore *
    signals.authority_multiplier *
    signals.intent_multiplier *
    signals.evidence_multiplier *
    signals.origin_multiplier *
    signals.epistemic_multiplier;

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
