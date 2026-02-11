#!/usr/bin/env node

/**
 * oddkit MCP Server
 *
 * Exposes oddkit as MCP tools for Cursor, Claude Code, and other MCP-compatible hosts.
 *
 * v2: Two-layer tool surface — unified `oddkit` orchestrator with state
 * threading + individual tools as direct, stateless access points.
 * All tools use `canon_url` for canon override.
 *
 * Tools:
 *   Layer 1 (orchestrator): oddkit — unified tool with action routing and state threading
 *   Layer 2 (individual):   oddkit_orient, oddkit_challenge, oddkit_gate, oddkit_encode,
 *                           oddkit_search, oddkit_get, oddkit_catalog, oddkit_validate,
 *                           oddkit_preflight, oddkit_version, oddkit_invalidate_cache
 *
 * Usage:
 *   node src/mcp/server.js
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync } from "fs";
import { runOrchestrate } from "./orchestrate.js";
// import { runOrchestrator } from "../orchestrator/index.js"; // Removed: absorbed into unified handler
import { listPrompts, getPrompt } from "./prompts.js";
import { getOddkitInstructions } from "./instructions.js";
import { resolveCanonTarget } from "../policy/canonTarget.js";
import { getDocByUri } from "../policy/docFetch.js";
import { runOrient } from "../tasks/orient.js";
import { runChallenge } from "../tasks/challenge.js";
import { runGate } from "../tasks/gate.js";
import { runEncode } from "../tasks/encode.js";
import { buildBM25Index, searchBM25 } from "../search/bm25.js";
import { buildIndex, loadIndex, saveIndex } from "../index/buildIndex.js";
import { ensureBaselineRepo } from "../baseline/ensureBaselineRepo.js";

// Read version from package.json to keep MCP server version in sync
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8"));
const VERSION = packageJson.version;

// Path to oddkit CLI
const ODDKIT_BIN = join(__dirname, "../../bin/oddkit");

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
// Execute oddkit CLI command and return parsed result
// ──────────────────────────────────────────────────────────────────────────────

function runOddkit(args) {
  try {
    const result = execSync(`node "${ODDKIT_BIN}" ${args}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });
    return JSON.parse(result.trim());
  } catch (err) {
    if (err.stdout) {
      try {
        return JSON.parse(err.stdout.trim());
      } catch {
        // Fall through
      }
    }
    return {
      tool: "unknown",
      schema_version: "1.0",
      ok: false,
      error: {
        message: err.message || "Command execution failed",
        code: "EXEC_ERROR",
      },
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Unified tool definition
// ──────────────────────────────────────────────────────────────────────────────

const ODDKIT_TOOL = {
  name: "oddkit",
  description: `Epistemic guide for Outcomes-Driven Development. Routes to orient, challenge, gate, encode, search, get, catalog, validate, preflight, version, or invalidate_cache actions.

Use when:
- Starting work: action="orient" to assess epistemic mode
- Policy/canon questions: action="search" with your query
- Fetching a specific doc: action="get" with URI
- Pressure-testing claims: action="challenge"
- Checking transition readiness: action="gate"
- Recording decisions: action="encode"
- Pre-implementation: action="preflight"
- Validating completion: action="validate"
- Listing available docs: action="catalog"`,
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "orient", "challenge", "gate", "encode", "search", "get",
          "catalog", "validate", "preflight", "version", "invalidate_cache",
        ],
        description: "Which epistemic action to perform.",
      },
      input: {
        type: "string",
        description: "Primary input — query, claim, URI, goal, or completion claim depending on action.",
      },
      context: {
        type: "string",
        description: "Optional supporting context.",
      },
      mode: {
        type: "string",
        enum: ["exploration", "planning", "execution"],
        description: "Optional epistemic mode hint.",
      },
      canon_url: {
        type: "string",
        description: "Optional GitHub repo URL for canon override.",
      },
      state: {
        type: "object",
        description: "Optional client-side conversation state, passed back and forth.",
      },
    },
    required: ["action", "input"],
  },
  annotations: {
    // No readOnlyHint: orchestrator routes to both read-only and write actions
    // (invalidate_cache). Individual tools carry accurate hints instead.
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

// ──────────────────────────────────────────────────────────────────────────────
// Layer 2: Individual tools — direct, stateless access to each action.
// Same internal handlers as the orchestrator, but no state threading.
// All use canon_url for canon override (not baseline/repo_root).
// ──────────────────────────────────────────────────────────────────────────────

const INDIVIDUAL_TOOLS = [
  {
    name: "oddkit_orient",
    description: "Assess a goal, idea, or situation against epistemic modes (exploration/planning/execution). Surfaces unresolved items, assumptions, and questions.",
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string", description: "A goal, idea, or situation description to orient against." },
        canon_url: { type: "string", description: "Optional: GitHub repo URL for canon override." },
      },
      required: ["input"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "oddkit_challenge",
    description: "Pressure-test a claim, assumption, or proposal against canon constraints. Surfaces tensions, missing evidence, and contradictions.",
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string", description: "A claim, assumption, or proposal to challenge." },
        mode: { type: "string", enum: ["exploration", "planning", "execution"], description: "Optional epistemic mode for proportional challenge." },
        canon_url: { type: "string", description: "Optional: GitHub repo URL for canon override." },
      },
      required: ["input"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "oddkit_gate",
    description: "Check transition prerequisites before changing epistemic modes. Validates readiness and blocks premature convergence.",
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string", description: "The proposed transition (e.g., 'ready to build', 'moving to planning')." },
        context: { type: "string", description: "Optional context about what's been decided so far." },
        canon_url: { type: "string", description: "Optional: GitHub repo URL for canon override." },
      },
      required: ["input"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "oddkit_encode",
    description: "Structure a decision, insight, or boundary as a durable record. Assesses quality and suggests improvements.",
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string", description: "A decision, insight, or boundary to capture." },
        context: { type: "string", description: "Optional supporting context." },
        canon_url: { type: "string", description: "Optional: GitHub repo URL for canon override." },
      },
      required: ["input"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "oddkit_search",
    description: "Search canon and baseline docs by natural language query or tags. Returns ranked results with citations and excerpts.",
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string", description: "Natural language query or tags to search for." },
        canon_url: { type: "string", description: "Optional: GitHub repo URL for canon override." },
      },
      required: ["input"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "oddkit_get",
    description: "Fetch a canonical document by klappy:// URI. Returns full content, commit, and content hash.",
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string", description: "Canonical URI (e.g., klappy://canon/values/orientation)." },
        canon_url: { type: "string", description: "Optional: GitHub repo URL for canon override." },
      },
      required: ["input"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "oddkit_catalog",
    description: "Lists available documentation with categories, counts, and start-here suggestions.",
    inputSchema: {
      type: "object",
      properties: {
        canon_url: { type: "string", description: "Optional: GitHub repo URL for canon override." },
      },
      required: [],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "oddkit_validate",
    description: "Validates completion claims against required artifacts. Returns VERIFIED or NEEDS_ARTIFACTS.",
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string", description: "The completion claim with artifact references." },
      },
      required: ["input"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "oddkit_preflight",
    description: "Pre-implementation check. Returns relevant docs, constraints, definition of done, and pitfalls.",
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string", description: "Description of what you're about to implement." },
        canon_url: { type: "string", description: "Optional: GitHub repo URL for canon override." },
      },
      required: ["input"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "oddkit_version",
    description: "Returns oddkit version and the authoritative canon target (commit/mode).",
    inputSchema: {
      type: "object",
      properties: {
        canon_url: { type: "string", description: "Optional: GitHub repo URL for canon override." },
      },
      required: [],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "oddkit_invalidate_cache",
    description: "Force refresh of cached baseline/canon data. Next request will fetch fresh data.",
    inputSchema: {
      type: "object",
      properties: {
        canon_url: { type: "string", description: "Optional: GitHub repo URL to invalidate cache for." },
      },
      required: [],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

const ALL_TOOLS = [ODDKIT_TOOL, ...INDIVIDUAL_TOOLS];

/**
 * Get tools to expose based on environment
 * Default: all tools (orchestrator + individual)
 * ODDKIT_DEV_TOOLS=1: same (kept for backward compat)
 */
function getTools() {
  return ALL_TOOLS;
}

// ──────────────────────────────────────────────────────────────────────────────
// Response text builders (kept for task handler results)
// ──────────────────────────────────────────────────────────────────────────────

function buildOrientResponse(taskResult) {
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

function buildChallengeResponse(taskResult) {
  if (taskResult.status === "ERROR") return `Error: ${taskResult.error}`;
  const lines = [`Challenge (${taskResult.claim_type}):`, ""];
  if (taskResult.tensions?.length > 0) { lines.push("Tensions found:"); for (const t of taskResult.tensions) lines.push(`  - [${t.type}] ${t.message}`); lines.push(""); }
  if (taskResult.missing_prerequisites?.length > 0) { lines.push("Missing prerequisites:"); for (const m of taskResult.missing_prerequisites) lines.push(`  - ${m}`); lines.push(""); }
  if (taskResult.challenges?.length > 0) { lines.push("Questions to address:"); for (const c of taskResult.challenges) lines.push(`  - ${c}`); lines.push(""); }
  if (taskResult.suggested_reframings?.length > 0) { lines.push("Suggested reframings:"); for (const r of taskResult.suggested_reframings) lines.push(`  - ${r}`); lines.push(""); }
  if (taskResult.canon_constraints?.length > 0) { lines.push("Canon constraints:"); for (const c of taskResult.canon_constraints) { lines.push(`  > ${c.quote}`); lines.push(`  — ${c.citation}`); lines.push(""); } }
  return lines.join("\n").trim();
}

function buildGateResponse(taskResult) {
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

function buildEncodeResponse(taskResult) {
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

const VALID_ACTIONS = [
  "orient", "challenge", "gate", "encode", "search", "get",
  "catalog", "validate", "preflight", "version", "invalidate_cache",
];

async function handleUnifiedAction(params) {
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
        // BM25 search over the document index
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
        // Fetch doc by klappy:// URI
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
        // Route through orchestrate with catalog action
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
        // Clear cached BM25 index
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

// ──────────────────────────────────────────────────────────────────────────────
// Resource helpers
// ──────────────────────────────────────────────────────────────────────────────

function getQuickStartResource() {
  return `ODDKIT QUICK START FOR AGENTS

You have access to the \`oddkit\` tool for policy retrieval and completion validation.

THREE CRITICAL MOMENTS TO CALL ODDKIT:

1. BEFORE IMPLEMENTING
   Call: oddkit({ action: "preflight", input: "<what you're implementing>" })
   Returns: Start here / Constraints / Definition of Done / Pitfalls

2. WHEN YOU HAVE QUESTIONS
   Call: oddkit({ action: "search", input: "<your question>" })
   Returns: Relevant docs with citations and evidence quotes

3. BEFORE CLAIMING DONE
   Call: oddkit({ action: "validate", input: "done: <what you completed>" })
   Returns: VERIFIED or NEEDS_ARTIFACTS with missing evidence list

RESPONSE HANDLING:
- Use the "assistant_text" field from the response directly
- It contains a complete answer with citations

COMMON PATTERNS:
- Policy question: { action: "search", input: "What is the definition of done?" }
- Preflight: { action: "preflight", input: "add authentication" }
- Validate: { action: "validate", input: "done: implemented login. Screenshot: login.png" }
- Discovery: { action: "catalog", input: "" }

IMPORTANT: Never pre-inject large documents. Always retrieve on-demand via oddkit.`.trim();
}

function getExamplesResource() {
  return `ODDKIT USAGE EXAMPLES

=== SEARCH (policy question) ===
{ action: "search", input: "What evidence is required for UI changes?" }
→ Returns relevant docs with citations and quotes

=== PREFLIGHT (before implementing) ===
{ action: "preflight", input: "implement user authentication with OAuth" }
→ Returns: Start here / Constraints / DoD / Pitfalls

=== VALIDATE (completion) ===
{ action: "validate", input: "done: implemented search. Screenshot: search.png" }
→ Returns: VERIFIED or NEEDS_ARTIFACTS

=== CATALOG (discovery) ===
{ action: "catalog", input: "" }
→ Returns: doc counts, categories, start-here docs

=== GET (fetch specific doc) ===
{ action: "get", input: "klappy://canon/values/orientation" }
→ Returns: full document content

=== ORIENT (epistemic mode) ===
{ action: "orient", input: "I want to build a new feature" }
→ Returns: mode assessment, assumptions, questions

=== STATE THREADING ===
Call 1: oddkit({ action: "orient", input: "...", state: null })
→ Returns: { ..., state: { phase: "exploration", ... } }
Call 2: oddkit({ action: "challenge", input: "...", state: <state from call 1> })
→ Returns: { ..., state: { phase: "exploration", unresolved: [...], ... } }`.trim();
}

// ──────────────────────────────────────────────────────────────────────────────
// MCP Server setup
// ──────────────────────────────────────────────────────────────────────────────

async function main() {
  const server = new Server(
    {
      name: "oddkit",
      version: VERSION,
      instructions: getOddkitInstructions(),
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
        resources: {},
      },
    },
  );

  // Handle list tools request
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: getTools() };
  });

  // Handle list prompts request
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return { prompts: await listPrompts() };
  });

  // Handle get prompt request
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name } = request.params;
    const prompt = await getPrompt(name);
    if (!prompt) throw new Error(`Unknown prompt: ${name}`);
    return prompt;
  });

  // Handle list resources request
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        { uri: "oddkit://instructions", name: "ODDKIT Decision Gate", description: "When and how to call oddkit", mimeType: "text/plain" },
        { uri: "oddkit://quickstart", name: "ODDKIT Quick Start for Agents", description: "Essential oddkit usage patterns for spawned agents", mimeType: "text/plain" },
        { uri: "oddkit://examples", name: "ODDKIT Usage Examples", description: "Common oddkit call patterns", mimeType: "text/plain" },
      ],
    };
  });

  // Handle read resource request
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (uri === "oddkit://instructions") {
      const text = getOddkitInstructions();
      return { contents: [{ uri, mimeType: "text/plain", text }] };
    }
    if (uri === "oddkit://quickstart") {
      return { contents: [{ uri, mimeType: "text/plain", text: getQuickStartResource() }] };
    }
    if (uri === "oddkit://examples") {
      return { contents: [{ uri, mimeType: "text/plain", text: getExamplesResource() }] };
    }
    throw new Error(`Unknown resource: ${uri}`);
  });

  // Handle tool calls — two-layer routing
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    // Layer 1: Unified orchestrator — accepts state
    if (name === "oddkit") {
      const result = await handleUnifiedAction({
        action: args.action || "search",
        input: args.input || "",
        context: args.context,
        mode: args.mode,
        canon_url: args.canon_url,
        state: args.state,
        baseline: args.canon_url,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    // Layer 2: Individual tools — stateless, route to same handlers
    const actionFromName = {
      oddkit_orient: "orient",
      oddkit_challenge: "challenge",
      oddkit_gate: "gate",
      oddkit_encode: "encode",
      oddkit_search: "search",
      oddkit_get: "get",
      oddkit_catalog: "catalog",
      oddkit_validate: "validate",
      oddkit_preflight: "preflight",
      oddkit_version: "version",
      oddkit_invalidate_cache: "invalidate_cache",
    };

    const action = actionFromName[name];
    if (action) {
      const result = await handleUnifiedAction({
        action,
        input: args.input || "",
        context: args.context,
        mode: args.mode,
        canon_url: args.canon_url,
        baseline: args.canon_url,
        // No state for individual tools
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Start the MCP server (stdio transport).
 */
export async function startMcpServer() {
  return main();
}

// Auto-start only when this file is run directly
const isEntry = process.argv[1]?.endsWith("server.js");
if (isEntry) {
  startMcpServer().catch((err) => {
    console.error("Failed to start MCP server:", err);
    process.exit(1);
  });
}
