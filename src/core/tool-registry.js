/**
 * Shared tool registry for oddkit
 *
 * Single source of truth for all 11 tool definitions.
 * Both MCP server and CLI read from this registry.
 * Neither defines tool metadata independently.
 *
 * See: CLI-MCP Parity plan (D0012)
 */

// ──────────────────────────────────────────────────────────────────────────────
// Orchestrator tool builder (MCP Layer 1 only — not a CLI command)
// Defined as a function so it can derive its action enum from TOOLS below.
// ──────────────────────────────────────────────────────────────────────────────

function buildOrchestratorTool(actionNames) {
  return {
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
          enum: actionNames,
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
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Individual tools (Layer 2 — both CLI commands and MCP tools)
// This is the single source of truth for action names, schemas, and metadata.
// ──────────────────────────────────────────────────────────────────────────────

export const TOOLS = [
  {
    name: "orient",
    mcpName: "oddkit_orient",
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
    cliFlags: {
      input: { flag: "-i, --input <text>", description: "A goal, idea, or situation description to orient against", required: true },
    },
  },
  {
    name: "challenge",
    mcpName: "oddkit_challenge",
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
    cliFlags: {
      input: { flag: "-i, --input <text>", description: "A claim, assumption, or proposal to challenge", required: true },
      mode: { flag: "-m, --mode <mode>", description: "Epistemic mode: exploration, planning, or execution" },
    },
  },
  {
    name: "gate",
    mcpName: "oddkit_gate",
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
    cliFlags: {
      input: { flag: "-i, --input <text>", description: "The proposed transition (e.g., 'ready to build')", required: true },
      context: { flag: "-c, --context <text>", description: "Context about what's been decided so far" },
    },
  },
  {
    name: "encode",
    mcpName: "oddkit_encode",
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
    cliFlags: {
      input: { flag: "-i, --input <text>", description: "A decision, insight, or boundary to capture", required: true },
      context: { flag: "-c, --context <text>", description: "Supporting context" },
    },
  },
  {
    name: "search",
    mcpName: "oddkit_search",
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
    cliFlags: {
      input: { flag: "-i, --input <text>", description: "Natural language query or tags to search for", required: true },
    },
  },
  {
    name: "get",
    mcpName: "oddkit_get",
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
    cliFlags: {
      input: { flag: "-i, --input <text>", description: "Canonical URI (e.g., klappy://canon/values/orientation)", required: true },
    },
  },
  {
    name: "catalog",
    mcpName: "oddkit_catalog",
    description: "Lists available documentation with categories, counts, and start-here suggestions.",
    inputSchema: {
      type: "object",
      properties: {
        canon_url: { type: "string", description: "Optional: GitHub repo URL for canon override." },
      },
      required: [],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    cliFlags: {
      input: { flag: "-i, --input <text>", description: "Optional filter or context" },
    },
  },
  {
    name: "validate",
    mcpName: "oddkit_validate",
    description: "Validates completion claims against required artifacts. Returns VERIFIED or NEEDS_ARTIFACTS.",
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string", description: "The completion claim with artifact references." },
      },
      required: ["input"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    cliFlags: {
      input: { flag: "-i, --input <text>", description: "The completion claim with artifact references", required: true },
    },
  },
  {
    name: "preflight",
    mcpName: "oddkit_preflight",
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
    cliFlags: {
      input: { flag: "-i, --input <text>", description: "Description of what you're about to implement", required: true },
    },
  },
  {
    name: "version",
    mcpName: "oddkit_version",
    description: "Returns oddkit version and the authoritative canon target (commit/mode).",
    inputSchema: {
      type: "object",
      properties: {
        canon_url: { type: "string", description: "Optional: GitHub repo URL for canon override." },
      },
      required: [],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    cliFlags: {},
  },
  {
    name: "invalidate_cache",
    mcpName: "oddkit_invalidate_cache",
    description: "Force refresh of cached baseline/canon data. Next request will fetch fresh data.",
    inputSchema: {
      type: "object",
      properties: {
        canon_url: { type: "string", description: "Optional: GitHub repo URL to invalidate cache for." },
      },
      required: [],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    cliFlags: {},
  },
];

// ──────────────────────────────────────────────────────────────────────────────
// Derived constants — single source of truth is TOOLS above
// ──────────────────────────────────────────────────────────────────────────────

/** Canonical list of action names, derived from TOOLS. */
export const ACTION_NAMES = TOOLS.map((t) => t.name);

/** Orchestrator tool definition with action enum derived from TOOLS. */
export const ORCHESTRATOR_TOOL = buildOrchestratorTool(ACTION_NAMES);

/** Map from MCP tool name → action name */
export const MCP_NAME_TO_ACTION = Object.fromEntries(
  TOOLS.map((t) => [t.mcpName, t.name])
);

/** All MCP tools (orchestrator + individual) */
export const ALL_MCP_TOOLS = [
  ORCHESTRATOR_TOOL,
  ...TOOLS.map((t) => ({
    name: t.mcpName,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations,
  })),
];
