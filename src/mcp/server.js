#!/usr/bin/env node

/**
 * oddkit MCP Server
 *
 * Exposes oddkit as MCP tools for Cursor, Claude Code, and other MCP-compatible hosts.
 *
 * Tools:
 *   - oddkit_librarian: Ask a policy/lookup question
 *   - oddkit_validate: Validate a completion claim
 *   - oddkit_explain: Explain the last oddkit result
 *
 * Usage:
 *   node src/mcp/server.js
 *
 * Or via npx:
 *   npx oddkit mcp
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
import { runOrchestrator } from "../orchestrator/index.js";
import { listPrompts, getPrompt } from "./prompts.js";
import { getOddkitInstructions } from "./instructions.js";
import { resolveCanonTarget } from "../policy/canonTarget.js";
import { getDocByUri } from "../policy/docFetch.js";

// Read version from package.json to keep MCP server version in sync
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8"));
const VERSION = packageJson.version;

// Path to oddkit CLI
const ODDKIT_BIN = join(__dirname, "../../bin/oddkit");

/**
 * Execute oddkit CLI command and return parsed result
 */
function runOddkit(args) {
  try {
    const result = execSync(`node "${ODDKIT_BIN}" ${args}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large outputs
    });
    return JSON.parse(result.trim());
  } catch (err) {
    // If command failed but we got stdout, try to parse it (tooljson errors go to stdout)
    if (err.stdout) {
      try {
        return JSON.parse(err.stdout.trim());
      } catch {
        // Fall through to error handling
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

/**
 * Tool definitions (tool-grade contracts; repo_root in schema for MCP clients)
 */
const ALL_TOOLS = [
  {
    name: "oddkit_orchestrate",
    description: `Routes a message to librarian/validate/explain and returns tool-grade JSON with ready-to-send assistant_text.

MUST: Before editing files or implementing a spec, call with your implementation plan.
MUST: Before claiming done/fixed/shipped/merged, call with completion claim + artifact paths.

Use when:
- Policy/canon questions ("what's the rule?", "is this allowed?")
- Contradictions or low confidence
- Discoverability ("what's in ODD?", "list canon")
- Instruction sync (action="instruction_sync" with baseline_root or registry_payload)`,
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string" },
        action: {
          type: "string",
          enum: [
            "orient",
            "catalog",
            "preflight",
            "librarian",
            "validate",
            "explain",
            "instruction_sync",
          ],
          description:
            "Explicit action override. instruction_sync requires baseline_root or registry_payload.",
        },
        repo_root: {
          type: "string",
          description: "Path to target repo. Default: current working directory.",
        },
        baseline: {
          type: "string",
          description: "Optional baseline git URL or local path.",
        },
        baseline_root: {
          type: "string",
          description: "For instruction_sync filesystem mode: path to klappy.dev baseline root.",
        },
        registry_payload: {
          type: "object",
          description:
            "For instruction_sync payload mode: registry object with version and instructions array.",
        },
        state_payload: {
          type: "object",
          description:
            "For instruction_sync payload mode: state object (requires registry_payload).",
        },
      },
      required: [],
    },
  },
  {
    name: "oddkit_librarian",
    description: "Retrieves governing/operational docs with quotes + citations.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        repo_root: { type: "string" },
        baseline: { type: "string" },
      },
      required: ["query"],
    },
  },
  {
    name: "oddkit_validate",
    description: "Validates completion claims against required artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string" },
        repo_root: { type: "string" },
        baseline: { type: "string" },
        artifacts: { type: "string" },
      },
      required: ["message"],
    },
  },
  {
    name: "oddkit_explain",
    description: "Explains the last oddkit run (from .oddkit/last.json).",
    inputSchema: {
      type: "object",
      properties: {
        repo_root: { type: "string" },
      },
    },
  },
  {
    name: "oddkit_policy_version",
    description: `Returns oddkit version and the authoritative canon target (commit/mode).
Use this to check if a derived subagent prompt is stale before proposing updates.`,
    inputSchema: {
      type: "object",
      properties: {
        baseline: {
          type: "string",
          description: "Optional baseline git URL or local path.",
        },
      },
    },
  },
  {
    name: "oddkit_policy_get",
    description: `Fetches a canonical doc by klappy:// URI at the current canon target.
Returns content, commit, and content hash.`,
    inputSchema: {
      type: "object",
      properties: {
        uri: {
          type: "string",
          description: "Canonical URI (e.g., klappy://canon/agents/odd-epistemic-guide)",
        },
        format: {
          type: "string",
          enum: ["markdown", "json"],
          description: "Output format (default: markdown)",
        },
        baseline: {
          type: "string",
          description: "Optional baseline git URL or local path.",
        },
      },
      required: ["uri"],
    },
  },
  {
    name: "oddkit_orchestrator",
    description: `Unified Guide + Scribe orchestrator with mode-aware posture.

Tracks current mode (discovery/planning/execution) and applies appropriate behavior:
- Discovery: High fuzziness tolerance, constructive adversarial pushback
- Planning: Options crystallizing, decisions locking, constraints surfacing
- Execution: Concrete, locked, artifact delivery

Also detects learnings/decisions/overrides in conversation and proposes ledger capture.

Use when:
- Starting or continuing agentic work
- Navigating mode transitions
- Capturing learnings or decisions`,
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The user message or context" },
        action: {
          type: "string",
          enum: ["orient", "catalog", "preflight", "librarian", "validate", "explain"],
          description: "Explicit action to take (optional, detected from message if omitted)",
        },
        mode: {
          type: "string",
          enum: ["discovery", "planning", "execution"],
          description: "Explicit mode override (optional, uses session state if omitted)",
        },
        transition_to: {
          type: "string",
          enum: ["discovery", "planning", "execution"],
          description: "Request mode transition",
        },
        capture_consent: {
          type: "boolean",
          description: "Consent to capture pending learnings/decisions",
        },
        capture_entry: {
          type: "object",
          description: "Specific entry to capture (requires capture_consent: true)",
        },
        reset_session: {
          type: "boolean",
          description: "Reset orchestrator state to fresh discovery mode",
        },
        repo_root: { type: "string", description: "Path to target repo" },
        baseline: { type: "string", description: "Optional baseline git URL or local path" },
      },
      required: [],
    },
  },
];

/**
 * Get tools to expose based on environment
 * Default: only oddkit_orchestrate
 * ODDKIT_DEV_TOOLS=1: all tools
 */
function getTools() {
  const devTools = process.env.ODDKIT_DEV_TOOLS === "1";
  if (devTools) {
    return ALL_TOOLS;
  }
  return [ALL_TOOLS[0]]; // Only oddkit_orchestrate
}

/**
 * Quick start resource for spawned agents
 * Provides essential context without overwhelming detail
 */
function getQuickStartResource() {
  return `ODDKIT QUICK START FOR AGENTS

You have access to oddkit_orchestrate for policy retrieval and completion validation.

THREE CRITICAL MOMENTS TO CALL ODDKIT:

1. BEFORE IMPLEMENTING
   Call: oddkit_orchestrate({ message: "preflight: <what you're implementing>", repo_root: "." })
   Returns: Start here / Constraints / Definition of Done / Pitfalls

2. WHEN YOU HAVE QUESTIONS
   Call: oddkit_orchestrate({ message: "<your question>", repo_root: "." })
   Returns: Answer with citations and evidence quotes

3. BEFORE CLAIMING DONE
   Call: oddkit_orchestrate({ message: "done: <what you completed>", repo_root: "." })
   Returns: VERIFIED or NEEDS_ARTIFACTS with missing evidence list

RESPONSE HANDLING:
- Use the "assistant_text" field from the response directly
- It contains a complete answer with citations
- Don't add extra narration - the text is ready to use

COMMON PATTERNS:
- Policy question: { "message": "What is the definition of done?" }
- Preflight: { "message": "preflight: add authentication" }
- Validate: { "message": "done: implemented login. Screenshot: login.png" }
- Discovery: { "message": "What's in ODD?" }

IMPORTANT: Never pre-inject large documents. Always retrieve on-demand via oddkit.
`.trim();
}

/**
 * Examples resource showing common usage patterns
 */
function getExamplesResource() {
  return `ODDKIT USAGE EXAMPLES

=== PREFLIGHT (before implementing) ===

Request:
{
  "message": "preflight: implement user authentication with OAuth",
  "repo_root": "."
}

Response includes:
- Start here: files to read first
- Constraints: rules that apply
- Definition of Done: what completion looks like
- Pitfalls: common mistakes to avoid


=== POLICY QUESTION ===

Request:
{
  "message": "What evidence is required for UI changes?",
  "repo_root": "."
}

Response includes:
- Answer with 2-4 substantial quotes
- Citations (file#section format)
- Read next suggestions


=== COMPLETION VALIDATION ===

Request:
{
  "message": "done: implemented search feature with tests. Screenshot: search.png, Test output: npm test passed",
  "repo_root": "."
}

Response verdict:
- VERIFIED: All required evidence provided
- NEEDS_ARTIFACTS: Lists what's missing


=== DISCOVERY (what's available) ===

Request:
{
  "message": "What's in ODD? Show me the canon.",
  "repo_root": "."
}

Response includes:
- Start here documents
- Top canon by category
- Playbooks and guides


=== EXPLICIT ACTION ===

Sometimes you want to force a specific action:

Request:
{
  "message": "...",
  "action": "preflight",
  "repo_root": "."
}

Valid actions: preflight, catalog, librarian, validate, explain, orient
`.trim();
}

/**
 * Create and start the MCP server
 */
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
    return {
      tools: getTools(),
    };
  });

  // Handle list prompts request (async - loads from registry)
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: await listPrompts(),
    };
  });

  // Handle get prompt request (async - loads from registry)
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name } = request.params;
    const prompt = await getPrompt(name);
    if (!prompt) {
      throw new Error(`Unknown prompt: ${name}`);
    }
    return prompt;
  });

  // Handle list resources request
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        {
          uri: "oddkit://instructions",
          name: "ODDKIT Decision Gate",
          description: "When and how to call oddkit_orchestrate",
          mimeType: "text/plain",
        },
        {
          uri: "oddkit://quickstart",
          name: "ODDKIT Quick Start for Agents",
          description: "Essential oddkit usage patterns for spawned agents",
          mimeType: "text/plain",
        },
        {
          uri: "oddkit://examples",
          name: "ODDKIT Usage Examples",
          description: "Common oddkit_orchestrate call patterns",
          mimeType: "text/plain",
        },
      ],
    };
  });

  // Handle read resource request
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    if (uri === "oddkit://instructions") {
      const text = getOddkitInstructions();
      if (process.env.ODDKIT_DEBUG_MCP) {
        console.error(`oddkit: served resource uri=${uri} len=${text.length}`);
      }
      return {
        contents: [{ uri, mimeType: "text/plain", text }],
      };
    }

    if (uri === "oddkit://quickstart") {
      const text = getQuickStartResource();
      return {
        contents: [{ uri, mimeType: "text/plain", text }],
      };
    }

    if (uri === "oddkit://examples") {
      const text = getExamplesResource();
      return {
        contents: [{ uri, mimeType: "text/plain", text }],
      };
    }

    throw new Error(`Unknown resource: ${uri}`);
  });

  // Handle tool calls (normalize repo_root / repoRoot for backward compatibility)
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const repoRoot = args.repo_root ?? args.repoRoot ?? process.cwd();

    switch (name) {
      case "oddkit_orchestrate": {
        const { message, baseline, action, baseline_root, registry_payload, state_payload } = args;
        try {
          const result = await runOrchestrate({
            message,
            repoRoot,
            baseline,
            action,
            baseline_root,
            registry_payload,
            state_payload,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    action: "error",
                    result: null,
                    debug: { error: err.message },
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
      }

      case "oddkit_librarian": {
        const { query, baseline } = args;
        let cmd = `tool librarian -q "${String(query).replace(/"/g, '\\"')}"`;
        if (repoRoot) cmd += ` -r "${repoRoot}"`;
        if (baseline) cmd += ` -b "${baseline}"`;

        const result = runOddkit(cmd);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "oddkit_validate": {
        const { message, baseline, artifacts } = args;
        let cmd = `tool validate -m "${String(message).replace(/"/g, '\\"')}"`;
        if (repoRoot) cmd += ` -r "${repoRoot}"`;
        if (baseline) cmd += ` -b "${baseline}"`;
        if (artifacts) cmd += ` -a "${artifacts}"`;

        const result = runOddkit(cmd);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "oddkit_explain": {
        const result = runOddkit("tool explain");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "oddkit_policy_version": {
        const { baseline } = args;
        try {
          const canonTarget = await resolveCanonTarget(baseline);
          const result = {
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
          };
          if (canonTarget.error) {
            result.error = {
              code: "CANON_TARGET_UNKNOWN",
              message: canonTarget.error,
            };
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    oddkit_version: VERSION,
                    policy_schema: "1.0.0",
                    error: {
                      code: "CANON_TARGET_UNKNOWN",
                      message: err.message || "Failed to resolve canon target",
                    },
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
      }

      case "oddkit_policy_get": {
        const { uri, format = "markdown", baseline } = args;
        try {
          const result = await getDocByUri(uri, { format, baseline });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    uri,
                    error: {
                      code: "DOC_FETCH_ERROR",
                      message: err.message || "Failed to fetch document",
                    },
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
      }

      case "oddkit_orchestrator": {
        const {
          message,
          action,
          mode,
          transition_to,
          capture_consent,
          capture_entry,
          reset_session,
          baseline,
        } = args;
        try {
          const result = await runOrchestrator({
            message,
            repoRoot,
            baseline,
            action,
            mode,
            transition_to,
            capture_consent,
            capture_entry,
            reset_session,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    action: "error",
                    success: false,
                    error: err.message,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Start the MCP server (stdio transport). No banners in normal operation.
 */
export async function startMcpServer() {
  return main();
}

// Auto-start only when this file is run directly (e.g. node src/mcp/server.js)
const isEntry = process.argv[1]?.endsWith("server.js");
if (isEntry) {
  startMcpServer().catch((err) => {
    console.error("Failed to start MCP server:", err);
    process.exit(1);
  });
}
