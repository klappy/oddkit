#!/usr/bin/env node

/**
 * oddkit MCP Server
 *
 * Exposes oddkit as MCP tools for Cursor, Claude Code, and other MCP-compatible hosts.
 *
 * v3: Uses shared core/actions.js and core/tool-registry.js.
 * Tool definitions and action routing are shared with the CLI.
 *
 * Tools:
 *   Layer 1 (orchestrator): oddkit — unified tool with action routing and state threading
 *   Layer 2 (individual):   oddkit_orient, oddkit_challenge, oddkit_gate, oddkit_encode,
 *                           oddkit_search, oddkit_get, oddkit_catalog, oddkit_validate,
 *                           oddkit_preflight, oddkit_version, oddkit_cleanup_storage
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
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync } from "fs";
import { listPrompts, getPrompt } from "./prompts.js";
import { getOddkitInstructions } from "./instructions.js";
import { handleAction } from "../core/actions.js";
import { ALL_MCP_TOOLS, MCP_NAME_TO_ACTION } from "../core/tool-registry.js";

// Read version from package.json to keep MCP server version in sync
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8"));
const VERSION = packageJson.version;

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

  // Handle list tools request — reads from shared registry
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: ALL_MCP_TOOLS };
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

  // Handle tool calls — two-layer routing via shared handleAction
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    // Layer 1: Unified orchestrator — accepts state
    if (name === "oddkit") {
      const result = await handleAction({
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

    // Layer 2: Individual tools — stateless, route to same handler
    const action = MCP_NAME_TO_ACTION[name];
    if (action) {
      const result = await handleAction({
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
