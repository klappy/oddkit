/**
 * oddkit MCP Worker
 *
 * Remote MCP server for oddkit, deployable to Cloudflare Workers.
 * Uses Cloudflare's `createMcpHandler` from the Agents SDK for
 * streamable-http transport (MCP 2025-03-26 spec).
 *
 * Architecture:
 *   /mcp          → createMcpHandler (MCP protocol)
 *   /             → Chat UI
 *   /api/chat     → Chat API
 *   /health       → Health check
 *   /.well-known/ → MCP server card
 *   *             → 404
 */

import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { handleUnifiedAction, type Env } from "./orchestrate";
import { ZipBaselineFetcher } from "./zip-baseline-fetcher";
import { renderChatPage } from "./chat-ui";
import { renderNotFoundPage } from "./not-found-ui";
import { handleChatRequest } from "./chat-api";
import pkg from "../package.json";

export type { Env };

const BUILD_VERSION = pkg.version;

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

interface PromptRegistryEntry {
  id: string;
  uri: string;
  path: string;
  audience: string;
}

interface PromptRegistry {
  version: string;
  instructions: PromptRegistryEntry[];
}

// ──────────────────────────────────────────────────────────────────────────────
// Prompt registry helpers — ZipBaselineFetcher with module-level cache
//
// Uses ZipBaselineFetcher (R2/KV content-addressed cache) for both registry
// and prompt content. Module-level cache (5-min TTL) avoids re-fetching the
// registry on every MCP request. Prompt content is fetched lazily on
// prompts/get and benefits from ZipBaselineFetcher's R2 cache.
//
// DO NOT replace with raw HTTP fetch — that bypasses the R2 cache pipeline
// and hammers raw.githubusercontent.com on every request. The .md filter
// bug that previously caused REGISTRY.json to return null has been fixed
// in ZipBaselineFetcher.getUnzipped (see zip-baseline-fetcher.ts).
// ──────────────────────────────────────────────────────────────────────────────

let cachedRegistry: PromptRegistry | null = null;
let registryFetchedAt = 0;
const REGISTRY_CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchPromptsRegistry(env: Env): Promise<PromptRegistry | null> {
  const now = Date.now();
  if (cachedRegistry && now - registryFetchedAt < REGISTRY_CACHE_TTL_MS) {
    return cachedRegistry;
  }
  try {
    const fetcher = new ZipBaselineFetcher(env);
    const registryJson = await fetcher.getFile("canon/instructions/REGISTRY.json");
    if (!registryJson) return cachedRegistry;
    cachedRegistry = JSON.parse(registryJson) as PromptRegistry;
    return cachedRegistry;
  } catch {
    return cachedRegistry;
  } finally {
    registryFetchedAt = now;
  }
}

async function fetchPromptContent(env: Env, path: string): Promise<string | null> {
  try {
    const fetcher = new ZipBaselineFetcher(env);
    const content = await fetcher.getFile(path);
    if (!content) return null;
    return content.replace(/^---[\s\S]*?---\n/, "").trim();
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// MCP Server — tool, resource, and prompt registration
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Create a fresh McpServer instance per request.
 *
 * MCP SDK 1.26.0+ requires new instances per request to prevent
 * cross-client data leakage (CVE fix). The `env` is closed over
 * at request time so tools can access bindings.
 *
 * Prompts are fetched from the baseline registry via ZipBaselineFetcher
 * (R2-cached) with module-level caching (5-minute TTL). Prompt content
 * is fetched lazily on prompts/get via the same R2 pipeline.
 */
async function createServer(env: Env): Promise<McpServer> {
  const server = new McpServer(
    {
      name: "oddkit",
      version: env.ODDKIT_VERSION || BUILD_VERSION,
    },
    {
      instructions:
        "oddkit provides epistemic governance — policy retrieval, completion validation, and decision capture. Use the unified `oddkit` tool with action parameter for multi-step workflows with state threading, or use individual tools (oddkit_search, oddkit_orient, oddkit_challenge, etc.) for direct, stateless calls.",
    },
  );

  // ── Layer 1: Unified orchestrator (state threading) ──────────────────────

  server.tool(
    "oddkit",
    `Epistemic guide for Outcomes-Driven Development. Routes to orient, challenge, gate, encode, search, get, catalog, validate, preflight, version, or cleanup_storage actions.

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
    {
      action: z.enum([
        "orient", "challenge", "gate", "encode", "search", "get",
        "catalog", "validate", "preflight", "version", "cleanup_storage",
      ]).describe("Which epistemic action to perform."),
      input: z.string().describe("Primary input — query, claim, URI, goal, or completion claim depending on action."),
      context: z.string().optional().describe("Optional supporting context."),
      mode: z.enum(["exploration", "planning", "execution"]).optional().describe("Optional epistemic mode hint."),
      canon_url: z.string().optional().describe("Optional GitHub repo URL for canon override."),
      include_metadata: z.boolean().optional().describe("When true, search/get responses include a metadata object with full parsed frontmatter. Default: false."),
      state: z.record(z.string(), z.unknown()).optional().describe("Optional client-side conversation state, passed back and forth."),
    },
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async (args) => {
      const result = await handleUnifiedAction({
        action: args.action,
        input: args.input,
        context: args.context,
        mode: args.mode,
        canon_url: args.canon_url,
        include_metadata: args.include_metadata,
        state: args.state as any,
        env,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ── Layer 2: Individual tools (stateless, direct access) ─────────────────

  const individualTools: Array<{
    name: string;
    description: string;
    action: string;
    schema: Record<string, z.ZodTypeAny>;
    annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  }> = [
    {
      name: "oddkit_orient",
      description: "Assess a goal, idea, or situation against epistemic modes (exploration/planning/execution). Surfaces unresolved items, assumptions, and questions.",
      action: "orient",
      schema: {
        input: z.string().describe("A goal, idea, or situation description to orient against."),
        canon_url: z.string().optional().describe("Optional: GitHub repo URL for canon override."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    {
      name: "oddkit_challenge",
      description: "Pressure-test a claim, assumption, or proposal against canon constraints. Surfaces tensions, missing evidence, and contradictions.",
      action: "challenge",
      schema: {
        input: z.string().describe("A claim, assumption, or proposal to challenge."),
        mode: z.enum(["exploration", "planning", "execution"]).optional().describe("Optional epistemic mode for proportional challenge."),
        canon_url: z.string().optional().describe("Optional: GitHub repo URL for canon override."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    {
      name: "oddkit_gate",
      description: "Check transition prerequisites before changing epistemic modes. Validates readiness and blocks premature convergence.",
      action: "gate",
      schema: {
        input: z.string().describe("The proposed transition (e.g., 'ready to build', 'moving to planning')."),
        context: z.string().optional().describe("Optional context about what's been decided so far."),
        canon_url: z.string().optional().describe("Optional: GitHub repo URL for canon override."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    {
      name: "oddkit_encode",
      description: "Structure a decision, insight, or boundary as a durable record. Assesses quality and suggests improvements.",
      action: "encode",
      schema: {
        input: z.string().describe("A decision, insight, or boundary to capture."),
        context: z.string().optional().describe("Optional supporting context."),
        canon_url: z.string().optional().describe("Optional: GitHub repo URL for canon override."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "oddkit_search",
      description: "Search canon and baseline docs by natural language query or tags. Returns ranked results with citations and excerpts.",
      action: "search",
      schema: {
        input: z.string().describe("Natural language query or tags to search for."),
        canon_url: z.string().optional().describe("Optional: GitHub repo URL for canon override."),
        include_metadata: z.boolean().optional().describe("When true, each hit includes a metadata object with full parsed frontmatter. Default: false."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    {
      name: "oddkit_get",
      description: "Fetch a canonical document by klappy:// URI. Returns full content, commit, and content hash.",
      action: "get",
      schema: {
        input: z.string().describe("Canonical URI (e.g., klappy://canon/values/orientation)."),
        canon_url: z.string().optional().describe("Optional: GitHub repo URL for canon override."),
        include_metadata: z.boolean().optional().describe("When true, response includes a metadata object with full parsed frontmatter. Default: false."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    {
      name: "oddkit_catalog",
      description: "Lists available documentation with categories, counts, and start-here suggestions.",
      action: "catalog",
      schema: {
        canon_url: z.string().optional().describe("Optional: GitHub repo URL for canon override."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    {
      name: "oddkit_validate",
      description: "Validates completion claims against required artifacts. Returns VERIFIED or NEEDS_ARTIFACTS.",
      action: "validate",
      schema: {
        input: z.string().describe("The completion claim with artifact references."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "oddkit_preflight",
      description: "Pre-implementation check. Returns relevant docs, constraints, definition of done, and pitfalls.",
      action: "preflight",
      schema: {
        input: z.string().describe("Description of what you're about to implement."),
        canon_url: z.string().optional().describe("Optional: GitHub repo URL for canon override."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    {
      name: "oddkit_version",
      description: "Returns oddkit version and the authoritative canon target (commit/mode).",
      action: "version",
      schema: {
        canon_url: z.string().optional().describe("Optional: GitHub repo URL for canon override."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "oddkit_cleanup_storage",
      description: "Storage hygiene: clears orphaned cached data. NOT required for correctness — content-addressed caching ensures fresh content is served automatically when the baseline changes.",
      action: "cleanup_storage",
      schema: {
        canon_url: z.string().optional().describe("Optional: GitHub repo URL for canon override."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];

  for (const tool of individualTools) {
    server.tool(
      tool.name,
      tool.description,
      tool.schema,
      tool.annotations,
      async (args: Record<string, unknown>) => {
        const result = await handleUnifiedAction({
          action: tool.action,
          input: (args.input as string) || "",
          context: args.context as string | undefined,
          mode: args.mode as string | undefined,
          canon_url: args.canon_url as string | undefined,
          include_metadata: args.include_metadata as boolean | undefined,
          env,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );
  }

  // ── Resources ────────────────────────────────────────────────────────────

  server.resource(
    "ODDKIT Decision Gate",
    "oddkit://instructions",
    { mimeType: "text/plain" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: getInstructionsResource() }],
    }),
  );

  server.resource(
    "ODDKIT Quick Start for Agents",
    "oddkit://quickstart",
    { mimeType: "text/plain" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: getQuickStartResource() }],
    }),
  );

  server.resource(
    "ODDKIT Usage Examples",
    "oddkit://examples",
    { mimeType: "text/plain" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: getExamplesResource() }],
    }),
  );

  // ── Prompts (from baseline registry via ZipBaselineFetcher, cached at module scope)
  //
  // Registry is fetched via ZipBaselineFetcher (R2-cached, content-addressed).
  // Module-level cache (5-min TTL) avoids re-fetching on every MCP request.
  // Prompt content is fetched lazily on prompts/get via the same R2 pipeline.

  try {
    const registry = await fetchPromptsRegistry(env);
    if (registry) {
      for (const inst of registry.instructions.filter((i) => i.audience === "agent")) {
        server.prompt(inst.id, `Agent: ${inst.id} (${inst.uri})`, async () => {
          const text = await fetchPromptContent(env, inst.path);
          return {
            messages: [
              {
                role: "user" as const,
                content: { type: "text" as const, text: text || `Failed to load prompt: ${inst.path}` },
              },
            ],
          };
        });
      }
    }
  } catch {
    // Non-fatal: prompts are supplementary. Tools and resources still work.
  }

  return server;
}

// ──────────────────────────────────────────────────────────────────────────────
// Resource content (unchanged from original)
// ──────────────────────────────────────────────────────────────────────────────

function getInstructionsResource(): string {
  return `ODDKIT DECISION GATE

You have access to the \`oddkit\` tool for epistemic governance.

CALL oddkit WHEN:
1. About to implement something → oddkit({ action: "preflight", input: "what you're building" })
2. Have a policy/rules question → oddkit({ action: "search", input: "your question" })
3. Claiming completion → oddkit({ action: "validate", input: "done: what you completed" })
4. Need to understand available docs → oddkit({ action: "catalog", input: "" })
5. Starting a new task → oddkit({ action: "orient", input: "your goal" })
6. Testing a claim → oddkit({ action: "challenge", input: "your claim" })
7. Checking transition → oddkit({ action: "gate", input: "ready to build" })
8. Recording a decision → oddkit({ action: "encode", input: "your decision" })
9. Fetching a specific doc → oddkit({ action: "get", input: "klappy://canon/path" })

DO NOT CALL WHEN:
- Simple file operations with no policy implications
- Continuing work already preflighted
- User explicitly says to skip

The tool returns ready-to-use assistant_text with citations.
Optionally pass \`state\` to enable multi-turn context tracking.`;
}

function getQuickStartResource(): string {
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
- Don't add extra narration - the text is ready to use

COMMON PATTERNS:
- Policy question: { action: "search", input: "What is the definition of done?" }
- Preflight: { action: "preflight", input: "add user authentication" }
- Validate: { action: "validate", input: "done: implemented login. Screenshot: login.png" }
- Discovery: { action: "catalog", input: "" }

IMPORTANT: Never pre-inject large documents. Always retrieve on-demand via oddkit.`;
}

function getExamplesResource(): string {
  return `ODDKIT USAGE EXAMPLES

=== SEARCH (policy question) ===
{ action: "search", input: "What evidence is required for UI changes?" }
→ Returns relevant docs with citations and quotes

=== PREFLIGHT (before implementing) ===
{ action: "preflight", input: "implement user authentication with OAuth" }
→ Returns: Start here / Constraints / DoD / Pitfalls

=== VALIDATE (completion) ===
{ action: "validate", input: "done: implemented search. Screenshot: search.png, Tests: passed" }
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
→ Returns: { ..., state: { phase: "exploration", unresolved: [...], ... } }`;
}

// ──────────────────────────────────────────────────────────────────────────────
// CORS helper (for non-MCP routes; MCP CORS handled by createMcpHandler)
// ──────────────────────────────────────────────────────────────────────────────

function corsHeaders(origin: string = "*"): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, Last-Event-ID",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// HTTP handler
// ──────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    // Chat UI at root
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(renderChatPage(), {
        headers: {
          "Content-Type": "text/html;charset=utf-8",
          "Cache-Control": "no-cache",
          Link: `<${url.origin}/mcp>; rel="mcp-server-url", <${url.origin}/.well-known/mcp.json>; rel="mcp-server-card"`,
          ...corsHeaders(origin),
        },
      });
    }

    // Chat API
    if (url.pathname === "/api/chat" && request.method === "POST") {
      return handleChatRequest(request, env);
    }

    // MCP server card
    if (url.pathname === "/.well-known/mcp.json" && request.method === "GET") {
      const serverCard = {
        mcpServers: {
          oddkit: {
            url: `${url.origin}/mcp`,
            name: "oddkit",
            version: env.ODDKIT_VERSION || BUILD_VERSION,
            description: "Epistemic governance — policy retrieval, completion validation, and decision capture",
            capabilities: { tools: {}, resources: {}, prompts: {} },
          },
        },
      };
      return new Response(JSON.stringify(serverCard, null, 2), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=300",
          ...corsHeaders(origin),
        },
      });
    }

    // Health check
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          ok: true,
          service: "oddkit",
          version: env.ODDKIT_VERSION || BUILD_VERSION,
          endpoints: { chat: "/", api: "/api/chat", mcp: "/mcp", health: "/health" },
          capabilities: ["chat", "tools", "resources", "prompts"],
        }),
        {
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders(origin),
          },
        },
      );
    }

    // ── MCP endpoint ─────────────────────────────────────────────────────────
    // Delegate entirely to createMcpHandler which handles:
    //   - Streamable HTTP transport (MCP 2025-03-26 spec)
    //   - SSE and JSON response formats
    //   - Session management
    //   - GET/POST/DELETE method handling
    //   - CORS for MCP requests
    //   - Error responses in JSON-RPC format
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      const server = await createServer(env);
      const handler = createMcpHandler(server, {
        route: "/mcp",
        corsOptions: {
          origin: origin,
          methods: "GET, POST, DELETE, OPTIONS",
          headers: "Content-Type, Accept, Authorization, Mcp-Session-Id, Last-Event-ID",
          exposeHeaders: "Mcp-Session-Id",
        },
      });
      return handler(request, env, ctx);
    }

    return new Response(renderNotFoundPage(url.pathname, url.origin), {
      status: 404,
      headers: {
        "Content-Type": "text/html;charset=utf-8",
        "Cache-Control": "no-cache",
        ...corsHeaders(origin),
      },
    });
  },
};
