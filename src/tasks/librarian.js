import { buildIndex, loadIndex, saveIndex } from '../index/buildIndex.js';
import { ensureBaselineRepo, getBaselineRef } from '../baseline/ensureBaselineRepo.js';
import { applySupersedes } from '../resolve/applySupersedes.js';
import { tokenize, scoreDocument, findBestHeading } from '../utils/scoring.js';
import { extractQuote, formatCitation } from '../utils/slicing.js';

const MIN_EVIDENCE_BULLETS = 2;
const MAX_RESULTS = 5;

/**
 * Run the librarian command
 */
export async function runLibrarian(options) {
  const { query, repo: repoRoot } = options;

  // Ensure baseline
  const baseline = await ensureBaselineRepo();
  const baselineRef = getBaselineRef();

  // Load or build index
  let index = loadIndex(repoRoot);
  if (!index) {
    index = await buildIndex(repoRoot, baseline.root);
    saveIndex(index, repoRoot);
  }

  // Apply supersedes
  const { filtered: docs, suppressed } = applySupersedes(index.documents);

  // Tokenize query
  const queryTokens = tokenize(query);

  // Score all documents
  const scored = docs
    .map((doc) => ({
      doc,
      score: scoreDocument(doc, queryTokens),
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS);

  // Build evidence bullets
  const evidence = [];
  const sources = [];

  for (const { doc } of scored) {
    const heading = findBestHeading(doc, queryTokens);
    if (!heading) continue;

    const quote = extractQuote(doc, heading);
    if (!quote || quote.length < 20) continue;

    const citation = formatCitation(doc, heading);

    evidence.push({
      quote,
      citation,
      origin: doc.origin,
    });

    sources.push(citation);
  }

  // Determine status
  const status = evidence.length >= MIN_EVIDENCE_BULLETS ? 'SUPPORTED' : 'INSUFFICIENT_EVIDENCE';

  // Build answer
  let answer;
  if (status === 'SUPPORTED') {
    answer = `Found ${evidence.length} relevant document(s) for: "${query}"`;
  } else {
    answer = `Could not find sufficient evidence to answer: "${query}". Found ${evidence.length} partial match(es).`;
  }

  // Build read_next
  const readNext = [];
  if (scored.length > 0) {
    const topDoc = scored[0].doc;
    const heading = findBestHeading(topDoc, queryTokens);
    if (heading) {
      readNext.push({
        path: formatCitation(topDoc, heading),
        reason: 'Primary source',
      });
    }

    // Add a related doc if different
    if (scored.length > 1 && scored[1].doc.path !== topDoc.path) {
      const relatedHeading = findBestHeading(scored[1].doc, queryTokens);
      if (relatedHeading) {
        readNext.push({
          path: formatCitation(scored[1].doc, relatedHeading),
          reason: 'Related context',
        });
      }
    }
  }

  return {
    status,
    answer,
    evidence,
    sources,
    read_next: readNext.slice(0, 2),
    debug: {
      query,
      queryTokens,
      baseline_ref: baselineRef,
      baseline_ref_source: baseline.refSource,
      baseline_available: !!baseline.root,
      docs_considered: scored.length,
      suppressed: Object.keys(suppressed).length > 0 ? suppressed : null,
    },
  };
}
