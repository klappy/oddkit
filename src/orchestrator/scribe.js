/**
 * Scribe role for the ODD Orchestrator.
 *
 * The Scribe:
 * - "Smells" learnings, decisions, and overrides in conversation
 * - Proposes ledger entries (consent-gated, never auto-writes)
 * - Writes to ledger only after explicit consent
 */

import { existsSync, appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

/**
 * Smell patterns for detecting epistemic moments.
 * Each pattern has a regex and confidence level.
 */
const SMELL_PATTERNS = {
  learning: [
    { pattern: /\b(realized|discovered|learned that|turns out)\b/i, confidence: 0.8 },
    { pattern: /\b(didn't know|wasn't aware|now understand|now see)\b/i, confidence: 0.7 },
    { pattern: /\b(clarified|confirmed|verified|the issue was)\b/i, confidence: 0.6 },
    { pattern: /\b(aha|insight|key finding)\b/i, confidence: 0.7 },
  ],
  decision: [
    { pattern: /\b(decided to|choosing|going with|chose|selected)\b/i, confidence: 0.8 },
    { pattern: /\b(tradeoff is|instead of|rather than|over option)\b/i, confidence: 0.7 },
    { pattern: /\b(option [ABC123]|alternative|we'll use)\b/i, confidence: 0.6 },
    { pattern: /\b(committing to|locking in|final answer)\b/i, confidence: 0.9 },
  ],
  override: [
    { pattern: /\b(actually|scratch that|correction|wrong about)\b/i, confidence: 0.9 },
    { pattern: /\b(not what I meant|misunderstood|clarification)\b/i, confidence: 0.8 },
    { pattern: /\b(update:|revised:|changed my mind)\b/i, confidence: 0.7 },
    { pattern: /\b(previous was wrong|ignore what I said)\b/i, confidence: 0.9 },
  ],
  drift: [
    { pattern: /\b(that's not what|off track|getting sidetracked)\b/i, confidence: 0.9 },
    { pattern: /\b(lost focus|tangent|back to the point)\b/i, confidence: 0.7 },
    { pattern: /\b(let's refocus|wandering|scope creep)\b/i, confidence: 0.6 },
  ],
};

/**
 * Detect smells in a message.
 * Returns array of { type, confidence, match, context, proposed_entry }
 */
export function detectSmells(message, context = {}) {
  const smells = [];

  if (!message) return smells;

  for (const [type, patterns] of Object.entries(SMELL_PATTERNS)) {
    for (const { pattern, confidence } of patterns) {
      const match = message.match(pattern);
      if (match) {
        smells.push({
          type,
          confidence,
          match: match[0],
          context: extractContext(message, match.index),
          proposed_entry: buildProposedEntry(type, message, match, context),
        });
        break; // One smell per type per message
      }
    }
  }

  return smells;
}

/**
 * Build a proposed ledger entry.
 * Does NOT write - this is for consent-gated capture.
 */
function buildProposedEntry(type, message, match, context) {
  const timestamp = new Date().toISOString();
  const datePrefix = timestamp.slice(0, 10).replace(/-/g, "");

  if (type === "learning" || type === "drift") {
    return {
      ledger: "learnings",
      entry: {
        id: `learn-${datePrefix}-auto`,
        timestamp,
        summary: extractSummary(message, 100),
        trigger: type === "drift" ? "drift_signal" : "conversation",
        impact: "[TO BE FILLED]",
        confidence: 0.5, // Low until confirmed
        sources: context.sources || [],
        evidence: [],
        candidate_targets: [],
        proposed_escalation: "none",
      },
    };
  }

  if (type === "decision") {
    return {
      ledger: "decisions",
      entry: {
        id: `dec-${datePrefix}-auto`,
        timestamp,
        title: extractSummary(message, 50),
        status: "proposed",
        decision: extractSummary(message, 200),
        context: context.conversation_context || "",
        options_considered: [],
        rationale: [],
        consequences: [],
        evidence: [],
        links: [],
        supersedes: [],
        superseded_by: null,
        candidate_promotion: "none",
      },
    };
  }

  if (type === "override") {
    return {
      ledger: "learnings",
      entry: {
        id: `learn-${datePrefix}-override`,
        timestamp,
        summary: `Correction: ${extractSummary(message, 80)}`,
        trigger: "correction",
        impact: "Previous understanding updated",
        confidence: 0.7,
        sources: context.sources || [],
        evidence: [],
        candidate_targets: [],
        proposed_escalation: "none",
      },
    };
  }

  return null;
}

/**
 * Propose capture without writing.
 * Returns proposals with consent prompts.
 */
export function proposeCapture(smells, repoRoot) {
  const proposals = smells
    .filter((s) => s.proposed_entry)
    .map((s) => ({
      type: s.type,
      confidence: s.confidence,
      ledger: s.proposed_entry.ledger,
      entry: s.proposed_entry.entry,
      consent_prompt: buildConsentPrompt(s),
    }));

  return proposals;
}

/**
 * Write entry to ledger (only after consent).
 * Returns { success, path }
 */
export function writeLedgerEntry(entry, ledger, repoRoot) {
  const ledgerPath = join(repoRoot, "odd", "ledger", `${ledger}.jsonl`);

  // Ensure directory exists
  const dir = dirname(ledgerPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Generate unique ID if still placeholder
  if (entry.id.endsWith("-auto") || entry.id.endsWith("-override")) {
    const counter = Date.now().toString().slice(-4);
    entry.id = entry.id
      .replace(/-auto$/, `-${counter}`)
      .replace(/-override$/, `-override-${counter}`);
  }

  // Append entry as JSONL
  appendFileSync(ledgerPath, JSON.stringify(entry) + "\n");

  return { success: true, path: ledgerPath };
}

/**
 * Build a consent prompt for a smell.
 */
function buildConsentPrompt(smell) {
  const typeLabels = {
    learning: "a learning",
    decision: "a decision",
    override: "a correction",
    drift: "a drift signal",
  };

  return `I detected ${typeLabels[smell.type]} in the conversation. Would you like me to capture it to the ledger?`;
}

/**
 * Extract a summary from message, trimming to max length.
 */
function extractSummary(message, maxLen) {
  const clean = message.replace(/\s+/g, " ").trim();
  return clean.length > maxLen ? clean.slice(0, maxLen - 3) + "..." : clean;
}

/**
 * Extract context window around a match.
 */
function extractContext(message, matchIndex, windowSize = 100) {
  const start = Math.max(0, matchIndex - windowSize);
  const end = Math.min(message.length, matchIndex + windowSize);
  return message.slice(start, end);
}
