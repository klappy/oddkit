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
  // Cite governing Canon document for arbitration decisions
  if (debug.governing_canon) {
    lines.push(`- Governing doctrine: \`${debug.governing_canon}\``);
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
  if (result.confidence !== undefined) {
    lines.push(`- Confidence: ${Math.round(result.confidence * 100)}%`);
  }
  if (result.advisory) {
    lines.push(`- ⚠️ **Advisory**: Low confidence — result is not authoritative`);
  }
  if (result.arbitration?.outcome) {
    lines.push(`- Arbitration outcome: **${result.arbitration.outcome}**`);
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

  // Confidence factors (explainability)
  if (result.confidence_factors) {
    const cf = result.confidence_factors;
    lines.push("## Confidence breakdown");
    lines.push(`- Margin (top vs second): ${Math.round(cf.margin * 100)}%`);
    lines.push(`- Coverage (evidence count): ${Math.round(cf.coverage * 100)}%`);
    lines.push(`- Evidence quality: ${Math.round(cf.evidence_quality * 100)}%`);
    lines.push(`- Intent quality: ${Math.round(cf.intent_quality * 100)}%`);
    if (cf.conflict_penalty > 0) {
      lines.push(`- Conflict penalty: -${Math.round(cf.conflict_penalty * 100)}%`);
    }
    lines.push("");
  }

  // Arbitration contradictions (per canon/weighted-relevance-and-arbitration.md: no silent resolution)
  if (result.arbitration?.contradictions && result.arbitration.contradictions.length > 0) {
    lines.push("## ⚠️ Contradictions detected");
    lines.push(
      "*Per canon/weighted-relevance-and-arbitration.md: conflicts are exposed, not resolved silently.*",
    );
    lines.push("");
    for (const c of result.arbitration.contradictions) {
      lines.push(`- **${c.type}** (${c.subtype || "untyped"}): ${c.message}`);
    }
    lines.push("");
  }

  // Vetoed items (hard veto enforcement)
  if (result.arbitration?.vetoed && result.arbitration.vetoed.length > 0) {
    lines.push("## Items demoted by intent veto");
    lines.push(
      "*Per Canon: these low-intent items were forcibly demoted below high-intent items.*",
    );
    lines.push("");
    for (const v of result.arbitration.vetoed) {
      lines.push(`- \`${v}\``);
    }
    lines.push("");
  }

  // Dedup info (index hygiene)
  if (result.arbitration?.dedup?.collapsed_groups > 0) {
    const dedup = result.arbitration.dedup;
    lines.push("## Index hygiene: duplicates collapsed");
    lines.push(
      `*${dedup.duplicate_count} duplicate(s) from ${dedup.collapsed_groups} identity group(s) were collapsed before scoring.*`,
    );
    lines.push("");
    for (const g of dedup.groups || []) {
      lines.push(`- **${g.id}**: kept \`${g.chosen.path}\` (${g.chosen.origin})`);
      for (const c of g.collapsed || []) {
        lines.push(`  - collapsed: \`${c.path}\` (${c.origin})`);
      }
    }
    lines.push("");
  }

  // Warnings (hygiene issues, not blocking)
  if (result.arbitration?.warnings && result.arbitration.warnings.length > 0) {
    // Separate by severity: high (errors), medium (warnings), low (info)
    const highSeverity = result.arbitration.warnings.filter((w) => w.severity === "high");
    const mediumSeverity = result.arbitration.warnings.filter((w) => w.severity === "medium");
    const lowSeverity = result.arbitration.warnings.filter((w) => w.severity === "low");
    const otherWarnings = result.arbitration.warnings.filter(
      (w) => !["high", "medium", "low"].includes(w.severity),
    );

    // HIGH: Metadata errors that must be fixed
    if (highSeverity.length > 0) {
      lines.push("## 🚨 Metadata errors (fix required)");
      lines.push("");
      for (const w of highSeverity) {
        lines.push(`- **${w.type}**: ${w.message}`);
        if (w.paths) {
          for (const p of w.paths) {
            lines.push(`  - \`${p.path}\` (hash: ${p.hash || "none"})`);
          }
        }
      }
      lines.push("");
    }

    // MEDIUM/OTHER: Hygiene warnings (smells)
    const hygieneWarnings = [...mediumSeverity, ...otherWarnings];
    if (hygieneWarnings.length > 0) {
      lines.push("## ⚠️ Hygiene warnings");
      lines.push(
        "*These are not blocking contradictions, but smells to track for promotion pipeline.*",
      );
      lines.push("");
      for (const w of hygieneWarnings) {
        if (w.type === "EXCESSIVE_DUPLICATES") {
          lines.push(`- **${w.type}**: ${w.message} (threshold: ${w.threshold}%)`);
        } else {
          lines.push(`- **${w.type}**: ${w.message}`);
        }
      }
      lines.push("");
    }

    // URI_DRIFT - informational, expected when local is ahead
    // Can be low or medium severity depending on magnitude
    const driftWarning = [...lowSeverity, ...mediumSeverity].find((w) => w.type === "URI_DRIFT");
    if (driftWarning) {
      const icon = driftWarning.severity === "medium" ? "⚠️" : "ℹ️";
      lines.push(`## ${icon} URI version drift`);

      // Show magnitude breakdown if available
      if (driftWarning.by_magnitude) {
        const { small, medium, large } = driftWarning.by_magnitude;
        lines.push(
          `*${driftWarning.count} URI(s) drifted: ${small} small, ${medium} medium, ${large} large. Using local versions.*`,
        );
      } else {
        lines.push(
          `*${driftWarning.count} URI(s) have local/baseline version differences. Using local versions.*`,
        );
      }

      if (driftWarning.governing_large_drifts > 0) {
        lines.push(
          `*⚠️ ${driftWarning.governing_large_drifts} governing doc(s) have large drift — consider review.*`,
        );
      }
      lines.push("");

      if (driftWarning.drifts && driftWarning.drifts.length > 0) {
        for (const d of driftWarning.drifts.slice(0, 5)) {
          const magBadge = d.magnitude ? `[${d.magnitude}]` : "";
          const govBadge = d.isGoverning ? " 🏛️" : "";
          lines.push(`- **${d.uri}** ${magBadge}${govBadge}`);
          if (d.local) {
            const lenInfo = d.local.length ? ` ${d.local.length} chars` : "";
            lines.push(`  - local: \`${d.local.path}\` (${d.local.hash}${lenInfo})`);
          }
          if (d.baseline) {
            const lenInfo = d.baseline.length ? ` ${d.baseline.length} chars` : "";
            lines.push(`  - baseline: \`${d.baseline.path}\` (${d.baseline.hash}${lenInfo})`);
          }
        }
        if (driftWarning.total_drifts > 5) {
          lines.push(`- *...and ${driftWarning.total_drifts - 5} more*`);
        }
      }
      lines.push("");
    }
  }

  // Candidates considered (arbitration transparency)
  if (
    result.arbitration?.candidates_considered &&
    result.arbitration.candidates_considered.length > 0
  ) {
    lines.push("## Candidates considered");
    for (const c of result.arbitration.candidates_considered) {
      const intentBadge = c.intent ? `[${c.intent}]` : "";
      const evidenceBadge = c.evidence && c.evidence !== "none" ? `[evidence:${c.evidence}]` : "";
      lines.push(
        `- \`${c.path}\` (score: ${c.score}, ${c.authority}) ${intentBadge} ${evidenceBadge}`.trim(),
      );
    }
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
