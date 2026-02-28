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
import { buildIndex, loadIndex, saveIndex, INDEX_VERSION } from "../index/buildIndex.js";
import { ensureBaselineRepo, getSessionSha } from "../baseline/ensureBaselineRepo.js";
import { ALL_ACTION_NAMES } from "./tool-registry.js";
import { validateFiles } from "../utils/writeValidation.js";
import {
  parseBaselineUrl, getFileSha, writeFile,
  getDefaultBranch, getBranchSha, branchExists, createBranch, createPR,
  atomicMultiFileCommit,
} from "../utils/githubApi.js";
import { readFileSync, existsSync } from "fs";
import { createRequire } from "module";
import matter from "gray-matter";

const require = createRequire(import.meta.url);
const { version: VERSION } = require("../../package.json");

// ──────────────────────────────────────────────────────────────────────────────
// Valid actions — derived from the shared tool registry (single source of truth)
// ──────────────────────────────────────────────────────────────────────────────

export const VALID_ACTIONS = ALL_ACTION_NAMES;

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
// BM25 search index (lazy, SHA-keyed)
//
// Content-addressed: the BM25 index is keyed to the baseline commit SHA.
// When the SHA changes, the index is rebuilt from fresh content.
// No TTL. No manual invalidation for correctness.
// ──────────────────────────────────────────────────────────────────────────────

let cachedBM25 = null;
let cachedBM25Sha = null;

function getBM25Index(docs, baselineSha) {
  if (cachedBM25 && cachedBM25Sha === baselineSha && baselineSha) {
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
  cachedBM25Sha = baselineSha;
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
  const { action, input, context, mode, canon_url, state, include_metadata } = params;
  const repoRoot = params.repoRoot || process.cwd();
  const baseline = canon_url || params.baseline;
  const startMs = Date.now();

  // Helper: enrich debug output with baseline SHA for observability
  function makeDebug(extra = {}) {
    return {
      baseline_sha: getSessionSha(),
      ...extra,
      duration_ms: Date.now() - startMs,
      generated_at: new Date().toISOString(),
    };
  }

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
          debug: makeDebug(taskResult.debug),
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
          debug: makeDebug(taskResult.debug),
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
          debug: makeDebug(taskResult.debug),
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
          debug: makeDebug(taskResult.debug),
        };
      }

      case "search": {
        const baselineResult = await ensureBaselineRepo(baseline);
        const baselineAvailable = !!baselineResult.root;
        const baselineSha = baselineResult.commitSha || null;

        // Content-addressed index: rebuild if SHA changed or baseline availability changed
        let index = loadIndex(repoRoot);
        // Schema version gate: stale index shapes (e.g. missing frontmatter) silently
        // break newer features. A version mismatch forces a full rebuild.
        if (index && index.version !== INDEX_VERSION) {
          index = null;
        }
        if (index) {
          const hasBaselineDocs = index.documents.some((d) => d.origin === "baseline");
          const indexSha = index.baselineCommitSha || null;
          if (!baselineAvailable && hasBaselineDocs) index = null;
          else if (baselineAvailable && !hasBaselineDocs) index = null;
          else if (baselineSha && indexSha && baselineSha !== indexSha) index = null;
        }
        if (!index) {
          index = await buildIndex(repoRoot, baselineAvailable ? baselineResult.root : null);
          index.baselineCommitSha = baselineSha;
          saveIndex(index, repoRoot);
        }

        const bm25 = getBM25Index(index.documents, baselineSha);
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
            debug: makeDebug({ search_index_size: bm25.N }),
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
            hits: hits.map((h) => {
              const hit = {
                uri: h.uri,
                path: h.path,
                title: h.title,
                tags: h.tags,
                score: h.score,
                snippet: (h.contentPreview || "").slice(0, 200),
                source: h.origin || "local",
              };
              if (include_metadata) {
                if (h.frontmatter) {
                  hit.metadata = h.frontmatter;
                } else if (h.absolutePath && existsSync(h.absolutePath)) {
                  // Fallback: index predates frontmatter storage — parse from file
                  try {
                    const { data } = matter(readFileSync(h.absolutePath, "utf-8"));
                    if (data && Object.keys(data).length > 0) {
                      hit.metadata = data;
                    }
                  } catch {
                    // File not readable — omit metadata for this hit
                  }
                }
              }
              return hit;
            }),
            evidence,
            docs_considered: index.documents.length,
          },
          state: updatedState,
          assistant_text: assistantLines.join("\n").trim(),
          debug: makeDebug({ search_index_size: bm25.N }),
        };
      }

      case "get": {
        const format = "markdown";
        const uri = input;
        try {
          const result = await getDocByUri(uri, { format, baseline, include_metadata });
          const updatedState = state ? addCanonRefs(initState(state), [uri]) : undefined;
          return {
            action: "get",
            result,
            state: updatedState,
            assistant_text: result.content || JSON.stringify(result, null, 2),
            debug: makeDebug(),
          };
        } catch (err) {
          return {
            action: "get",
            result: { error: err.message, uri },
            state: state ? initState(state) : undefined,
            assistant_text: `Document not found: \`${uri}\`. Use action "search" or "catalog" to find available documents.`,
            debug: makeDebug(),
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
          debug: makeDebug(result.debug),
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
          debug: makeDebug(result.debug),
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
          debug: makeDebug(result.debug),
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
            debug: makeDebug(),
          };
        } catch (err) {
          return {
            action: "version",
            result: { oddkit_version: VERSION, error: err.message },
            assistant_text: `oddkit v${VERSION} | canon target resolution failed: ${err.message}`,
            debug: makeDebug(),
          };
        }
      }

      case "cleanup_storage": {
        // Hygiene-only: clears in-memory caches.
        // NOT required for correctness — content-addressed storage ensures
        // fresh content is served automatically when the baseline SHA changes.
        cachedBM25 = null;
        cachedBM25Sha = null;
        return {
          action: "cleanup_storage",
          result: { success: true },
          assistant_text: "In-memory caches cleared. Note: this is storage hygiene only. " +
            "Content-addressed caching ensures correct content is served automatically " +
            "when the baseline changes — no manual cleanup is required for correctness.",
          debug: makeDebug(),
        };
      }

      case "write": {
        // oddkit_write — one action, progressive protection
        // Tier 1: Contents API for single file
        // Tier 2: Git Data API for multi-file atomic commits
        // Tier 3: Branch creation and PR support (layers on top)
        const { files, message, pr, repo: providedRepo, author, provenance } = params;
        let { branch } = params;

        // --- Input validation ---
        if (!files || !Array.isArray(files) || files.length === 0) {
          return {
            action: "write",
            result: { error: "No files provided. Expected array of {path, content} objects." },
            assistant_text: "No files provided. Please provide an array of files with path and content.",
            debug: makeDebug(),
          };
        }

        if (!message) {
          return {
            action: "write",
            result: { error: "Commit message required." },
            assistant_text: "Commit message is required.",
            debug: makeDebug(),
          };
        }

        if (pr && !branch) {
          branch = `oddkit-write/${Date.now()}`;
        }

        // --- Resolve target repo ---
        let owner, repoName;

        if (providedRepo) {
          const parts = providedRepo.split("/");
          if (parts.length !== 2 || !parts[0] || !parts[1]) {
            return {
              action: "write",
              result: { error: `Invalid repo format: "${providedRepo}". Expected "owner/repo".` },
              assistant_text: `Invalid repo format: "${providedRepo}". Expected "owner/repo".`,
              debug: makeDebug(),
            };
          }
          owner = parts[0];
          repoName = parts[1];
        } else {
          const baselineUrl = baseline || process.env.ODDKIT_BASELINE;
          if (!baselineUrl) {
            return {
              action: "write",
              result: { error: "No target repo specified. Provide repo param or set ODDKIT_BASELINE." },
              assistant_text: "Write requires an explicit target repo. Provide the repo parameter (owner/repo) or set ODDKIT_BASELINE.",
              debug: makeDebug(),
            };
          }
          try {
            const parsed = parseBaselineUrl(baselineUrl);
            owner = parsed.owner;
            repoName = parsed.repo;
          } catch (err) {
            return {
              action: "write",
              result: { error: err.message },
              assistant_text: `Failed to parse baseline URL: ${err.message}. Set ODDKIT_BASELINE or use repo parameter.`,
              debug: makeDebug(),
            };
          }
        }

        // --- Validate files against governance constraints ---
        const validation = validateFiles(files);

        // Block writes if any path is unsafe (traversal sequences)
        const unsafePaths = validation.results
          .filter((r) => r.checks.some((c) => c.name === "path_safe" && !c.passed))
          .map((r) => r.file);
        if (unsafePaths.length > 0) {
          return {
            action: "write",
            result: { error: `Unsafe path(s) detected: ${unsafePaths.join(", ")}`, validation },
            assistant_text: `Write blocked: path traversal detected in ${unsafePaths.join(", ")}. Remove '..' sequences.`,
            debug: makeDebug(),
          };
        }

        // --- Build provenance footer ---
        // Use structured provenance param when present, fall back to surface from caller context
        const surfaceValue = provenance?.surface || params.surface || "mcp";
        const provenanceLines = [`oddkit-surface: ${surfaceValue}`];
        if (provenance?.session_id) {
          provenanceLines.push(`oddkit-session: ${provenance.session_id}`);
        }
        provenanceLines.push(`oddkit-timestamp: ${new Date().toISOString()}`);
        const commitMessage = `${message}\n\n---\n${provenanceLines.join("\n")}`;

        // --- Determine author ---
        const gitAuthor = author || null;

        try {
          // --- Resolve target branch ---
          let targetBranch = branch;
          let defaultBranch = null;
          let status = "committed";

          if (!targetBranch) {
            defaultBranch = await getDefaultBranch(owner, repoName);
            targetBranch = defaultBranch;
          } else {
            const exists = await branchExists(owner, repoName, targetBranch);
            if (!exists) {
              defaultBranch = await getDefaultBranch(owner, repoName);
              const sourceSha = await getBranchSha(owner, repoName, defaultBranch);
              await createBranch(owner, repoName, targetBranch, sourceSha);
              status = "branch_created";
            }
          }

          // --- Write files ---
          let commitResult;

          if (files.length === 1) {
            // Tier 1: Contents API — single file
            const file = files[0];
            const sha = await getFileSha(owner, repoName, file.path, targetBranch);
            const result = await writeFile(
              owner, repoName, file.path, file.content,
              commitMessage, targetBranch, sha, gitAuthor,
            );
            commitResult = { commit_sha: result.commit_sha, commit_url: result.commit_url };
          } else {
            // Tier 2: Git Data API — multi-file atomic commit
            commitResult = await atomicMultiFileCommit(
              owner, repoName, targetBranch, files, commitMessage, gitAuthor,
            );
          }

          // --- Handle PR if requested (Tier 3) ---
          let prResult = null;
          // TODO: Orphan prevention (Layer 4) — before creating a new PR, check for
          // existing open PRs from oddkit on the same branch or targeting the same files.
          // If found, push to the existing branch instead (the PR updates automatically).
          // The output interface supports this via pr_updated. Deferred until Layer 4.
          if (pr && branch) {
            const prOpts = typeof pr === "object" ? pr : {};
            const prTitle = prOpts.title || message;
            const prBody = prOpts.body || `Files:\n${files.map((f) => `- ${f.path}`).join("\n")}\n\n---\nWritten via oddkit_write`;
            const prDraft = prOpts.draft || false;
            const baseBranch = defaultBranch || await getDefaultBranch(owner, repoName);
            prResult = await createPR(owner, repoName, prTitle, prBody, branch, baseBranch, prDraft);
            status = "pr_opened";
          }

          const filesWritten = files.map((f) => f.path);
          const validationWarnings = !validation.passed
            ? validation.results.map((r) => r.checks.filter((c) => !c.passed).map((c) => c.name).join(", ")).filter((x) => x).join("; ")
            : "";

          return {
            action: "write",
            result: {
              status,
              commit_sha: commitResult.commit_sha,
              commit_url: commitResult.commit_url,
              branch: targetBranch,
              files_written: filesWritten,
              pr_url: prResult?.pr_url || undefined,
              pr_number: prResult?.pr_number || undefined,
              pr_updated: false, // TODO: set to true when orphan prevention detects existing PR
              validation,
            },
            assistant_text: `Successfully wrote ${filesWritten.length} file(s) to ${owner}/${repoName} on branch ${targetBranch}. Commit: ${commitResult.commit_url}${prResult ? `\nPR: ${prResult.pr_url}` : ""}${validationWarnings ? `\n\nValidation warnings: ${validationWarnings}` : ""}`,
            debug: makeDebug({ files_count: files.length, tier: files.length === 1 ? 1 : 2, validation_passed: validation.passed }),
          };

        } catch (err) {
          // --- Conflict handling ---
          if (err.status === 409 && err.conflictData) {
            return {
              action: "write",
              result: {
                status: "conflict",
                error: err.message,
                conflict: err.conflictData,
                validation,
              },
              assistant_text: `${err.conflictData.guidance || err.message}`,
              debug: makeDebug({ files_count: files.length }),
            };
          }

          // --- Network failure: preserve content so it's not lost ---
          const preserved = err.retryFailed
            ? files.map((f) => ({ path: f.path, content: f.content }))
            : undefined;

          return {
            action: "write",
            result: {
              error: err.message,
              validation,
              preserved_content: preserved,
            },
            assistant_text: `Write failed: ${err.message}${preserved ? "\n\nFile contents have been preserved in the response so they are not lost." : ""}${!validation.passed ? "\nValidation warnings: " + validation.results.map((r) => r.checks.filter((c) => !c.passed).map((c) => c.name).join(", ")).filter((x) => x).join("; ") : ""}`,
            debug: makeDebug({ files_count: files.length }),
          };
        }
      }

      default:
        return {
          action: "error",
          result: { error: `Unhandled action: ${action}` },
          assistant_text: `Unhandled action: ${action}`,
          debug: makeDebug(),
        };
    }
  } catch (err) {
    return {
      action: "error",
      result: { error: err.message || "Unknown error" },
      state: state ? initState(state) : undefined,
      assistant_text: `Error in ${action}: ${err.message || "Unknown error"}`,
      debug: makeDebug(),
    };
  }
}
