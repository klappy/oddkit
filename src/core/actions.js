/**
 * Shared action handler for oddkit
 *
 * Extracted from src/mcp/server.js to be the single router for all 11 actions.
 * Both CLI and MCP server import and call handleAction(). Neither defines
 * its own routing logic.
 *
 * See: CLI-MCP Parity plan (D0012)
 */

import { runOrchestrate } from "../mcp/orchestrate.js";
import { resolveCanonTarget } from "../policy/canonTarget.js";
import { getDocByUri } from "../policy/docFetch.js";
import { runOrient } from "../tasks/orient.js";
import { runChallenge } from "../tasks/challenge.js";
import { runGate } from "../tasks/gate.js";
import { runEncode } from "../tasks/encode.js";
import { buildBM25Index, searchBM25 } from "../search/bm25.js";
import { buildIndex, loadIndex, saveIndex } from "../index/buildIndex.js";
import { ensureBaselineRepo } from "../baseline/ensureBaselineRepo.js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { version: VERSION } = require("../../package.json");

// ──────────────────────────────────────────────────────────────────────────────
// Valid actions
// ──────────────────────────────────────────────────────────────────────────────

export const VALID_ACTIONS = [
  "orient", "challenge", "gate", "encode", "search", "get",
  "catalog", "validate", "preflight", "version", "invalidate_cache",
];

// ──────────────────────────────────────────────────────────────────────────────
// State management
// ──────────────────────────────────────────────────────────────────────────────

function initState(existing) {
  return {
    phase: existing?.phase || "exploration",
    gates_passed: existing?.gates_passed || [],
    decisions_encoded: existing?.decisions_encoded || [],
    unresolved: existing?.unresolved || [],
    canon_refs: existing?.canon_refs || [],
  };
}

function addCanonRefs(state, paths) {
  const existing = new Set(state.canon_refs);
  for (const p of paths) {
    if (!existing.has(p)) {
      state.canon_refs.push(p);
    }
  }
  return state;
}

// ──────────────────────────────────────────────────────────────────────────────
// BM25 search index (lazy, cached)
// ──────────────────────────────────────────────────────────────────────────────

let cachedBM25 = null;
let cachedIndexDocs = null;

function getBM25Index(docs) {
  if (cachedBM25 && cachedIndexDocs === docs) {
    return cachedBM25;
  }

  const documents = docs.map((doc) => ({
    id: doc.path,
    text: [
      doc.title || "",
      doc.path.replace(/[/_.-]/g, " "),
      (doc.tags || []).join(" "),
      doc.contentPreview || "",
    ].join(" "),
  }));

  cachedBM25 = buildBM25Index(documents);
  cachedIndexDocs = docs;
  return cachedBM25;
}

// ──────────────────────────────────────────────────────────────────────────────
// Response text builders
// ──────────────────────────────────────────────────────────────────────────────

export function buildOrientResponse(taskResult) {
  if (taskResult.status === "ERROR") return `Error: ${taskResult.error}`;
  const lines = [];
  if (taskResult.creed?.length > 0) {
    lines.push("The Creed:");
    for (const line of taskResult.creed) lines.push(`  ${line}`);
    lines.push("");
  }
  lines.push(`Orientation: ${taskResult.current_mode} mode (${taskResult.mode_confidence} confidence)`, "");
  if (taskResult.unresolved?.length > 0) { lines.push("Unresolved:"); for (const item of taskResult.unresolved) lines.push(`  - ${item}`); lines.push(""); }
  if (taskResult.assumptions?.length > 0) { lines.push("Assumptions detected:"); for (const a of taskResult.assumptions) lines.push(`  - ${a}`); lines.push(""); }
  if (taskResult.suggested_questions?.length > 0) { lines.push("Questions to answer before progressing:"); for (const q of taskResult.suggested_questions) lines.push(`  - ${q}`); lines.push(""); }
  if (taskResult.canon_refs?.length > 0) { lines.push("Relevant canon:"); for (const ref of taskResult.canon_refs) { lines.push(`  > ${ref.quote}`); lines.push(`  — ${ref.path}`); lines.push(""); } }
  return lines.join("\n").trim();
}

export function buildChallengeResponse(taskResult) {
  if (taskResult.status === "ERROR") return `Error: ${taskResult.error}`;
  const lines = [`Challenge (${taskResult.claim_type}):`, ""];
  if (taskResult.tensions?.length > 0) { lines.push("Tensions found:"); for (const t of taskResult.tensions) lines.push(`  - [${t.type}] ${t.message}`); lines.push(""); }
  if (taskResult.missing_prerequisites?.length > 0) { lines.push("Missing prerequisites:"); for (const m of taskResult.missing_prerequisites) lines.push(`  - ${m}`); lines.push(""); }
  if (taskResult.challenges?.length > 0) { lines.push("Questions to address:"); for (const c of taskResult.challenges) lines.push(`  - ${c}`); lines.push(""); }
  if (taskResult.suggested_reframings?.length > 0) { lines.push("Suggested reframings:"); for (const r of taskResult.suggested_reframings) lines.push(`  - ${r}`); lines.push(""); }
  if (taskResult.canon_constraints?.length > 0) { lines.push("Canon constraints:"); for (const c of taskResult.canon_constraints) { lines.push(`  > ${c.quote}`); lines.push(`  — ${c.citation}`); lines.push(""); } }
  return lines.join("\n").trim();
}

export function buildGateResponse(taskResult) {
  if (taskResult.status === "ERROR") return `Error: ${taskResult.error}`;
  const lines = [];
  lines.push(`Gate: ${taskResult.status === "PASS" ? "PASS" : "NOT READY"} (${taskResult.transition.from} → ${taskResult.transition.to})`, "");
  const prereqs = taskResult.prerequisites;
  lines.push(`Prerequisites: ${prereqs.required_met}/${prereqs.required_total} required met`, "");
  if (prereqs.met?.length > 0) { lines.push("Met:"); for (const m of prereqs.met) lines.push(`  + ${m}`); lines.push(""); }
  if (prereqs.unmet?.length > 0) { lines.push("Unmet (required):"); for (const u of prereqs.unmet) lines.push(`  - ${u}`); lines.push(""); }
  if (prereqs.unknown?.length > 0) { lines.push("Not confirmed:"); for (const u of prereqs.unknown) lines.push(`  ? ${u}`); lines.push(""); }
  if (taskResult.canon_refs?.length > 0) { lines.push("Relevant canon:"); for (const ref of taskResult.canon_refs) { lines.push(`  > ${ref.quote}`); lines.push(`  — ${ref.path}`); lines.push(""); } }
  return lines.join("\n").trim();
}

export function buildEncodeResponse(taskResult) {
  if (taskResult.status === "ERROR") return `Error: ${taskResult.error}`;
  const art = taskResult.artifact;
  const lines = [`Encoded ${art.type}: ${art.title}`, `Status: ${art.status} | Quality: ${taskResult.quality.level} (${taskResult.quality.score}/${taskResult.quality.max_score})`, ""];
  lines.push(`Decision: ${art.decision}`, `Rationale: ${art.rationale}`, "");
  if (art.constraints?.length > 0) { lines.push("Constraints:"); for (const c of art.constraints) lines.push(`  - ${c}`); lines.push(""); }
  if (taskResult.quality.gaps?.length > 0) { lines.push("Gaps:"); for (const g of taskResult.quality.gaps) lines.push(`  - ${g}`); lines.push(""); }
  if (taskResult.quality.suggestions?.length > 0) { lines.push("Suggestions to strengthen:"); for (const s of taskResult.quality.suggestions) lines.push(`  - ${s}`); lines.push(""); }
  if (taskResult.canon_refs?.length > 0) { lines.push("Relevant canon:"); for (const ref of taskResult.canon_refs) { lines.push(`  > ${ref.quote}`); lines.push(`  — ${ref.path}`); lines.push(""); } }
  return lines.join("\n").trim();
}

// ──────────────────────────────────────────────────────────────────────────────
// Unified action handler
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Handle any of the 11 oddkit actions.
 *
 * @param {Object} params
 * @param {string} params.action - One of VALID_ACTIONS
 * @param {string} params.input - Primary input
 * @param {string} [params.context] - Optional supporting context
 * @param {string} [params.mode] - Optional epistemic mode hint
 * @param {string} [params.canon_url] - Optional canon override URL
 * @param {string} [params.baseline] - Baseline override (canon_url takes precedence)
 * @param {string} [params.repoRoot] - Repository root (defaults to cwd)
 * @param {Object} [params.state] - Optional state for threading (MCP orchestrator)
 * @returns {Object} { action, result, assistant_text, debug, state? }
 */
export async function handleAction(params) {
  const { action, input, context, mode, canon_url, state } = params;
  const repoRoot = params.repoRoot || process.cwd();
  const baseline = canon_url || params.baseline;
  const startMs = Date.now();

  if (!VALID_ACTIONS.includes(action)) {
    return {
      action: "error",
      result: { error: `Unknown action: ${action}. Valid: ${VALID_ACTIONS.join(", ")}` },
      assistant_text: `Unknown action: ${action}. Valid actions: ${VALID_ACTIONS.join(", ")}`,
      debug: { generated_at: new Date().toISOString() },
    };
  }

  try {
    switch (action) {
      case "orient": {
        const taskResult = await runOrient({ input, repo: repoRoot, baseline });
        const assistantText = buildOrientResponse(taskResult);
        const updatedState = state ? initState(state) : undefined;
        if (updatedState) {
          updatedState.phase = taskResult.current_mode || updatedState.phase;
          if (taskResult.assumptions) updatedState.unresolved = [...updatedState.unresolved, ...taskResult.assumptions.slice(0, 3)];
          if (taskResult.canon_refs) addCanonRefs(updatedState, taskResult.canon_refs.map((r) => r.path));
        }
        return {
          action: "orient",
          result: taskResult,
          state: updatedState,
          assistant_text: assistantText,
          debug: { ...taskResult.debug, duration_ms: Date.now() - startMs, generated_at: new Date().toISOString() },
        };
      }

      case "challenge": {
        const taskResult = await runChallenge({ input, mode, repo: repoRoot, baseline });
        const assistantText = buildChallengeResponse(taskResult);
        const updatedState = state ? initState(state) : undefined;
        if (updatedState && taskResult.missing_prerequisites) {
          updatedState.unresolved = [...updatedState.unresolved, ...taskResult.missing_prerequisites];
        }
        return {
          action: "challenge",
          result: taskResult,
          state: updatedState,
          assistant_text: assistantText,
          debug: { ...taskResult.debug, duration_ms: Date.now() - startMs, generated_at: new Date().toISOString() },
        };
      }

      case "gate": {
        const taskResult = await runGate({ input, context, repo: repoRoot, baseline });
        const assistantText = buildGateResponse(taskResult);
        const updatedState = state ? initState(state) : undefined;
        if (updatedState && taskResult.status === "PASS" && taskResult.transition) {
          updatedState.gates_passed.push(`${taskResult.transition.from} → ${taskResult.transition.to}`);
          if (taskResult.transition.to === "planning" || taskResult.transition.to === "execution") {
            updatedState.phase = taskResult.transition.to;
          }
        }
        return {
          action: "gate",
          result: taskResult,
          state: updatedState,
          assistant_text: assistantText,
          debug: { ...taskResult.debug, duration_ms: Date.now() - startMs, generated_at: new Date().toISOString() },
        };
      }

      case "encode": {
        const taskResult = await runEncode({ input, context, repo: repoRoot, baseline });
        const assistantText = buildEncodeResponse(taskResult);
        const updatedState = state ? initState(state) : undefined;
        if (updatedState && taskResult.artifact) {
          updatedState.decisions_encoded.push(taskResult.artifact.title);
        }
        return {
          action: "encode",
          result: taskResult,
          state: updatedState,
          assistant_text: assistantText,
          debug: { ...taskResult.debug, duration_ms: Date.now() - startMs, generated_at: new Date().toISOString() },
        };
      }

      case "search": {
        const baselineResult = await ensureBaselineRepo(baseline);
        const baselineAvailable = !!baselineResult.root;

        let index = loadIndex(repoRoot);
        if (index) {
          const hasBaselineDocs = index.documents.some((d) => d.origin === "baseline");
          if (!baselineAvailable && hasBaselineDocs) index = null;
          else if (baselineAvailable && !hasBaselineDocs) index = null;
        }
        if (!index) {
          index = await buildIndex(repoRoot, baselineAvailable ? baselineResult.root : null);
          saveIndex(index, repoRoot);
        }

        const bm25 = getBM25Index(index.documents);
        const results = searchBM25(bm25, input, 5);

        const docMap = new Map(index.documents.map((d) => [d.path, d]));
        const hits = results
          .map((r) => {
            const doc = docMap.get(r.id);
            if (!doc) return null;
            return { ...doc, score: r.score };
          })
          .filter(Boolean);

        const updatedState = state ? addCanonRefs(initState(state), hits.map((h) => h.path)) : undefined;

        if (hits.length === 0) {
          return {
            action: "search",
            result: { status: "NO_MATCH", docs_considered: index.documents.length, hits: [] },
            state: updatedState,
            assistant_text: `Searched ${index.documents.length} documents but found no matches for "${input}". Try rephrasing or use action "catalog".`,
            debug: { search_index_size: bm25.N, duration_ms: Date.now() - startMs, generated_at: new Date().toISOString() },
          };
        }

        const evidence = hits.slice(0, 3).map((h) => ({
          quote: (h.contentPreview || "").slice(0, 200),
          citation: `${h.path}#${h.title || ""}`,
          source: h.origin || "local",
        }));

        const assistantLines = [
          `Found ${hits.length} result(s) for: "${input}"`, "",
          ...evidence.map((e) => `> ${e.quote}\n— ${e.citation} (${e.source})`), "",
          "Results:",
          ...hits.map((r) => `- \`${r.path}\` — ${r.title || "(untitled)"} (score: ${r.score.toFixed(2)})`),
        ];

        return {
          action: "search",
          result: {
            status: "FOUND",
            hits: hits.map((h) => ({
              uri: h.uri,
              path: h.path,
              title: h.title,
              tags: h.tags,
              score: h.score,
              snippet: (h.contentPreview || "").slice(0, 200),
              source: h.origin || "local",
            })),
            evidence,
            docs_considered: index.documents.length,
          },
          state: updatedState,
          assistant_text: assistantLines.join("\n").trim(),
          debug: { search_index_size: bm25.N, duration_ms: Date.now() - startMs, generated_at: new Date().toISOString() },
        };
      }

      case "get": {
        const format = "markdown";
        const uri = input;
        try {
          const result = await getDocByUri(uri, { format, baseline });
          const updatedState = state ? addCanonRefs(initState(state), [uri]) : undefined;
          return {
            action: "get",
            result,
            state: updatedState,
            assistant_text: result.content || JSON.stringify(result, null, 2),
            debug: { duration_ms: Date.now() - startMs, generated_at: new Date().toISOString() },
          };
        } catch (err) {
          return {
            action: "get",
            result: { error: err.message, uri },
            state: state ? initState(state) : undefined,
            assistant_text: `Document not found: \`${uri}\`. Use action "search" or "catalog" to find available documents.`,
            debug: { duration_ms: Date.now() - startMs, generated_at: new Date().toISOString() },
          };
        }
      }

      case "catalog": {
        const result = await runOrchestrate({
          message: input || "catalog",
          repoRoot,
          baseline,
          action: "catalog",
        });
        return {
          action: "catalog",
          result: result.result || result,
          state: state ? initState(state) : undefined,
          assistant_text: result.assistant_text || JSON.stringify(result, null, 2),
          debug: { ...result.debug, duration_ms: Date.now() - startMs, generated_at: new Date().toISOString() },
        };
      }

      case "validate": {
        const result = await runOrchestrate({
          message: input,
          repoRoot,
          baseline,
          action: "validate",
        });
        return {
          action: "validate",
          result: result.result || result,
          state: state ? initState(state) : undefined,
          assistant_text: result.assistant_text || JSON.stringify(result, null, 2),
          debug: { ...result.debug, duration_ms: Date.now() - startMs, generated_at: new Date().toISOString() },
        };
      }

      case "preflight": {
        const result = await runOrchestrate({
          message: input.startsWith("preflight:") ? input : `preflight: ${input}`,
          repoRoot,
          baseline,
          action: "preflight",
        });
        return {
          action: "preflight",
          result: result.result || result,
          state: state ? initState(state) : undefined,
          assistant_text: result.assistant_text || JSON.stringify(result, null, 2),
          debug: { ...result.debug, duration_ms: Date.now() - startMs, generated_at: new Date().toISOString() },
        };
      }

      case "version": {
        try {
          const canonTarget = await resolveCanonTarget(baseline);
          return {
            action: "version",
            result: {
              oddkit_version: VERSION,
              policy_schema: "1.0.0",
              canon_target: {
                mode: canonTarget.mode,
                commit: canonTarget.commit,
                commit_full: canonTarget.commitFull || null,
                tag: canonTarget.tag || null,
                source: canonTarget.source,
                ref: canonTarget.ref || null,
                baseline_url: canonTarget.baselineUrl || null,
              },
            },
            assistant_text: `oddkit v${VERSION} | canon: ${canonTarget.commit || "unknown"}`,
            debug: { duration_ms: Date.now() - startMs, generated_at: new Date().toISOString() },
          };
        } catch (err) {
          return {
            action: "version",
            result: { oddkit_version: VERSION, error: err.message },
            assistant_text: `oddkit v${VERSION} | canon target resolution failed: ${err.message}`,
            debug: { duration_ms: Date.now() - startMs, generated_at: new Date().toISOString() },
          };
        }
      }

      case "invalidate_cache": {
        cachedBM25 = null;
        cachedIndexDocs = null;
        return {
          action: "invalidate_cache",
          result: { success: true },
          assistant_text: "Cache invalidated. Next request will rebuild the index.",
          debug: { duration_ms: Date.now() - startMs, generated_at: new Date().toISOString() },
        };
      }

      default:
        return {
          action: "error",
          result: { error: `Unhandled action: ${action}` },
          assistant_text: `Unhandled action: ${action}`,
          debug: { generated_at: new Date().toISOString() },
        };
    }
  } catch (err) {
    return {
      action: "error",
      result: { error: err.message || "Unknown error" },
      state: state ? initState(state) : undefined,
      assistant_text: `Error in ${action}: ${err.message || "Unknown error"}`,
      debug: { duration_ms: Date.now() - startMs, generated_at: new Date().toISOString() },
    };
  }
}
