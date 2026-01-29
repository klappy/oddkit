import { readLast } from "../state/last.js";
import { RULES, getRule, isKnownRule } from "./rules.js";

/**
 * Determine tool type from result
 */
function detectTool(result) {
  if (result.debug?.tool) {
    return result.debug.tool;
  }
  // Infer from fields
  if ("verdict" in result) {
    return "validate";
  }
  if ("status" in result) {
    return "librarian";
  }
  if ("stats" in result) {
    return "index";
  }
  return "unknown";
}

/**
 * Render rules fired section
 */
function renderRulesFired(rulesFired) {
  if (!rulesFired || rulesFired.length === 0) {
    return ["- No specific rules recorded."];
  }

  const lines = [];
  const unmapped = [];

  for (const code of rulesFired) {
    const rule = getRule(code);
    if (rule) {
      lines.push(`- **${rule.title}** — ${rule.meaning}`);
    } else {
      unmapped.push(code);
    }
  }

  if (unmapped.length > 0) {
    lines.push("");
    lines.push("**Unmapped rule codes:**");
    for (const code of unmapped) {
      lines.push(`- \`${code}\``);
    }
  }

  return lines;
}

/**
 * Render what to do next based on result
 */
function renderNextSteps(result, tool) {
  const lines = [];

  if (tool === "librarian") {
    if (result.status === "INSUFFICIENT_EVIDENCE") {
      lines.push("- Consider adding documentation for this topic.");
      lines.push("- Try a more specific query.");
      if (result.read_next && result.read_next.length > 0) {
        lines.push('- Check the "Read Next" suggestions for related content.');
      }
    } else {
      lines.push("- Open the cited sections to confirm they fully cover your question.");
      if (result.read_next && result.read_next.length > 0) {
        lines.push('- Explore "Read Next" for deeper context.');
      }
    }
  } else if (tool === "validate") {
    if (result.verdict === "NEEDS_ARTIFACTS") {
      lines.push('- Provide the missing artifacts listed in "Gaps" below.');
      if (result.gaps && result.gaps.length > 0) {
        lines.push("- Required: " + result.gaps.join(", "));
      }
    } else if (result.verdict === "CLARIFY") {
      lines.push("- Restate your completion claim more clearly.");
      lines.push("- Include what you completed and any artifacts.");
    } else if (result.verdict === "FAIL") {
      lines.push("- Review the evidence and address the issues.");
      lines.push("- Re-run validation after fixes.");
    } else if (result.verdict === "PASS") {
      lines.push("- Validation passed. You may proceed.");
    }
  } else if (tool === "index") {
    lines.push("- Index is ready. Run `oddkit librarian` to query.");
  }

  if (lines.length === 0) {
    lines.push("- Review the result and take appropriate action.");
  }

  return lines;
}

/**
 * Render evidence section
 */
function renderEvidence(evidence) {
  if (!evidence || evidence.length === 0) {
    return ["- No evidence provided."];
  }

  return evidence.map((e, i) => {
    const origin = e.origin ? ` (origin: ${e.origin})` : "";
    return `${i + 1}) "${e.quote}" — \`${e.citation}\`${origin}`;
  });
}

/**
 * Render evidence filtering section
 */
function renderEvidenceFiltering(debug) {
  const accepted = debug.evidence_accepted_count;
  const rejected = debug.evidence_rejected_count;
  const reasons = debug.evidence_rejected_reasons;

  // Only render if there's something interesting to show
  if (rejected === undefined || rejected === 0) {
    return null;
  }

  const lines = [];
  lines.push("## Evidence filtering");
  lines.push(`- Accepted evidence bullets: ${accepted}`);

  const reasonParts = Object.entries(reasons || {})
    .map(([code, count]) => `${code}: ${count}`)
    .join(", ");

  lines.push(`- Rejected candidates: ${rejected}${reasonParts ? ` (${reasonParts})` : ""}`);

  return lines;
}

/**
 * Render supersedes overrides section
 */
function renderSupersedesOverrides(suppressed) {
  if (!suppressed || Object.keys(suppressed).length === 0) {
    return null;
  }

  const lines = [];
  lines.push("## Overrides applied (supersedes)");
  for (const [suppressedUri, localPath] of Object.entries(suppressed)) {
    lines.push(`- Suppressed \`${suppressedUri}\` → overridden by \`${localPath}\``);
  }
  return lines;
}

/**
 * Render debug section
 */
function renderDebug(debug) {
  const lines = [];

  if (debug.repo_root) {
    lines.push(`- Repo: ${debug.repo_root}`);
  }
  if (debug.baseline_ref) {
    lines.push(`- Baseline ref: ${debug.baseline_ref}`);
  }
  if (debug.baseline_ref_source) {
    lines.push(`- Baseline ref source: ${debug.baseline_ref_source}`);
  }
  if (debug.baseline_available !== undefined) {
    lines.push(`- Baseline available: ${debug.baseline_available}`);
  }
  if (debug.baseline_commit) {
    lines.push(`- Baseline commit: ${debug.baseline_commit.slice(0, 12)}`);
  }
  if (debug.timestamp) {
    lines.push(`- Timestamp: ${debug.timestamp}`);
  }
  if (debug.policy_intent) {
    lines.push(`- Policy intent: ${debug.policy_intent}`);
  }
  if (debug.docs_considered !== undefined) {
    lines.push(`- Docs considered: ${debug.docs_considered}`);
  }
  if (debug.claims_detected_count !== undefined) {
    lines.push(`- Claims detected: ${debug.claims_detected_count}`);
  }
  if (debug.artifacts_detected_count !== undefined) {
    lines.push(`- Artifacts detected: ${debug.artifacts_detected_count}`);
  }
  // Note: suppressed is now rendered in its own section, not in debug
  if (debug.notes && debug.notes.length > 0) {
    lines.push(`- Notes: ${debug.notes.join("; ")}`);
  }

  return lines.length > 0 ? lines : ["- No debug info available."];
}

/**
 * Render explain output as markdown
 */
function renderMarkdown(result) {
  const tool = detectTool(result);
  const debug = result.debug || {};
  const lines = [];

  // Title
  lines.push("# oddkit explain — last run");
  lines.push("");

  // Result summary
  lines.push("## Result");
  lines.push(`- Tool: ${tool}`);
  if (result.status) {
    lines.push(`- Status: ${result.status}`);
  }
  if (result.verdict) {
    lines.push(`- Verdict: ${result.verdict}`);
  }
  if (result.answer) {
    lines.push(`- Answer: ${result.answer}`);
  }
  lines.push("");

  // Why this happened
  lines.push("## Why this happened");
  lines.push(...renderRulesFired(debug.rules_fired));
  lines.push("");

  // Overrides applied (supersedes) - show WHAT was suppressed
  const supersedesLines = renderSupersedesOverrides(debug.suppressed);
  if (supersedesLines) {
    lines.push(...supersedesLines);
    lines.push("");
  }

  // Evidence filtering - show why candidates were rejected
  const filteringLines = renderEvidenceFiltering(debug);
  if (filteringLines) {
    lines.push(...filteringLines);
    lines.push("");
  }

  // What to do next
  lines.push("## What to do next");
  lines.push(...renderNextSteps(result, tool));
  lines.push("");

  // Evidence (for librarian)
  if (result.evidence && result.evidence.length > 0) {
    lines.push("## Evidence used");
    lines.push(...renderEvidence(result.evidence));
    lines.push("");
  }

  // Read next (for librarian)
  if (result.read_next && result.read_next.length > 0) {
    lines.push("## Read next");
    for (const r of result.read_next) {
      lines.push(`- \`${r.path}\` — ${r.reason}`);
    }
    lines.push("");
  }

  // Gaps (for validate)
  if (result.gaps && result.gaps.length > 0) {
    lines.push("## Gaps");
    for (const g of result.gaps) {
      lines.push(`- ${g}`);
    }
    lines.push("");
  }

  // Debug
  lines.push("## Debug");
  lines.push(...renderDebug(debug));
  lines.push("");

  return lines.join("\n");
}

/**
 * Main explain function
 */
export function explainLast(options = {}) {
  const { format = "md" } = options;

  const result = readLast();

  if (format === "json") {
    // Return enriched JSON with rule explanations
    const tool = detectTool(result);
    const rulesExplained = (result.debug?.rules_fired || []).map((code) => {
      const rule = getRule(code);
      return rule ? { code, ...rule } : { code, title: code, meaning: "Unknown rule" };
    });

    return {
      ...result,
      _explain: {
        tool,
        rules_explained: rulesExplained,
        next_steps: renderNextSteps(result, tool),
      },
    };
  }

  return renderMarkdown(result);
}
