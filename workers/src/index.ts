/**
 * oddkit MCP Worker
 *
 * Remote MCP server for oddkit, deployable to Cloudflare Workers.
 * Provides policy retrieval and completion validation for Claude.ai.
 *
 * Uses streamable-http transport for MCP communication.
 *
 * v2: Two-layer tool surface — unified `oddkit` orchestrator with state
 * threading + individual tools as direct, stateless access points.
 * All tools use `canon_url` for canon override.
 */

import { handleUnifiedAction, type OddkitEnvelope, type Env } from "./orchestrate";
import { renderChatPage } from "./chat-ui";
import { renderNotFoundPage } from "./not-found-ui";
import { handleChatRequest } from "./chat-api";
import pkg from "../package.json";

export type { Env };

// ──────────────────────────────────────────────────────────────────────────────
// Tool definitions — Layer 1: Unified orchestrator + Layer 2: Individual tools
// ──────────────────────────────────────────────────────────────────────────────

const ODDKIT_TOOL = {
  name: "oddkit",
  description: `Epistemic guide for Outcomes-Driven Development. Routes to orient, challenge, gate, encode, search, get, catalog, validate, preflight, version, or cleanup_storage actions.

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
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: [
          "orient", "challenge", "gate", "encode", "search", "get",
          "catalog", "validate", "preflight", "version", "cleanup_storage",
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
      include_metadata: {
        type: "boolean",
        description: "When true, search/get responses include a metadata object with full parsed frontmatter. Default: false.",
      },
      state: {
        type: "object",
        description: "Optional client-side conversation state, passed back and forth.",
      },
    },
    required: ["action", "input"],
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

// Layer 2: Individual tools — direct, stateless access to each action.
// Same internal handlers as the orchestrator, but no state threading.
const INDIVIDUAL_TOOLS = [
  {
    name: "oddkit_orient",
    description: "Assess a goal, idea, or situation against epistemic modes (exploration/planning/execution). Surfaces unresolved items, assumptions, and questions.",
    inputSchema: {
      type: "object" as const,
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
      type: "object" as const,
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
      type: "object" as const,
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
      type: "object" as const,
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
      type: "object" as const,
      properties: {
        input: { type: "string", description: "Natural language query or tags to search for." },
        canon_url: { type: "string", description: "Optional: GitHub repo URL for canon override." },
        include_metadata: { type: "boolean", description: "When true, each hit includes a metadata object with full parsed frontmatter. Default: false." },
      },
      required: ["input"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "oddkit_get",
    description: "Fetch a canonical document by klappy:// URI. Returns full content, commit, and content hash.",
    inputSchema: {
      type: "object" as const,
      properties: {
        input: { type: "string", description: "Canonical URI (e.g., klappy://canon/values/orientation)." },
        canon_url: { type: "string", description: "Optional: GitHub repo URL for canon override." },
        include_metadata: { type: "boolean", description: "When true, response includes a metadata object with full parsed frontmatter. Default: false." },
      },
      required: ["input"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "oddkit_catalog",
    description: "Lists available documentation with categories, counts, and start-here suggestions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        canon_url: { type: "string", description: "Optional: GitHub repo URL for canon override." },
      },
      required: [] as string[],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "oddkit_validate",
    description: "Validates completion claims against required artifacts. Returns VERIFIED or NEEDS_ARTIFACTS.",
    inputSchema: {
      type: "object" as const,
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
      type: "object" as const,
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
      type: "object" as const,
      properties: {
        canon_url: { type: "string", description: "Optional: GitHub repo URL for canon override." },
      },
      required: [] as string[],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "oddkit_cleanup_storage",
    description: "Storage hygiene: clears orphaned cached data. NOT required for correctness — content-addressed caching ensures fresh content is served automatically when the baseline changes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        canon_url: { type: "string", description: "Optional: GitHub repo URL for canon override." },
      },
      required: [] as string[],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

const ALL_TOOLS = [ODDKIT_TOOL, ...INDIVIDUAL_TOOLS];

// ──────────────────────────────────────────────────────────────────────────────
// Resource definitions
// ──────────────────────────────────────────────────────────────────────────────

const RESOURCES = [
  {
    uri: "oddkit://instructions",
    name: "ODDKIT Decision Gate",
    description: "When and how to call the oddkit tool",
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
    description: "Common oddkit call patterns",
    mimeType: "text/plain",
  },
];

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

function getResourceContent(uri: string): string | null {
  switch (uri) {
    case "oddkit://instructions":
      return getInstructionsResource();
    case "oddkit://quickstart":
      return getQuickStartResource();
    case "oddkit://examples":
      return getExamplesResource();
    default:
      return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Prompt registry
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

async function fetchPromptsRegistry(baselineUrl: string): Promise<PromptRegistry | null> {
  try {
    const response = await fetch(`${baselineUrl}/canon/instructions/REGISTRY.json`);
    if (!response.ok) return null;
    return (await response.json()) as PromptRegistry;
  } catch {
    return null;
  }
}

async function fetchPromptContent(baselineUrl: string, path: string): Promise<string | null> {
  try {
    const response = await fetch(`${baselineUrl}/${path}`);
    if (!response.ok) return null;
    const content = await response.text();
    return content.replace(/^---[\s\S]*?---\n/, "").trim();
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// MCP protocol
// ──────────────────────────────────────────────────────────────────────────────

const PROTOCOL_VERSION = "2025-03-26";
const BUILD_VERSION = pkg.version;

function getServerInfo(envVersion: string | undefined) {
  return {
    name: "oddkit",
    version: envVersion || BUILD_VERSION,
  };
}

function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `oddkit-${timestamp}-${random}`;
}

function formatSseEvent(data: unknown, eventId?: string): string {
  const lines: string[] = [];
  if (eventId) lines.push(`id: ${eventId}`);
  lines.push("event: message");
  lines.push(`data: ${JSON.stringify(data)}`);
  lines.push("");
  return lines.join("\n") + "\n";
}

const MCP_TOOL_TIMEOUT_MS = 25_000;

// ──────────────────────────────────────────────────────────────────────────────
// Tool execution — unified routing
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Execute a tool call by routing to the unified handler.
 * Layer 1 (oddkit) passes state; Layer 2 (individual tools) does not.
 */
async function executeToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
  env: Env,
): Promise<OddkitEnvelope> {
  const canonUrl = args?.canon_url as string | undefined;

  const includeMetadata = args?.include_metadata as boolean | undefined;

  // Layer 1: Unified orchestrator — accepts state
  if (name === "oddkit") {
    return handleUnifiedAction({
      action: (args?.action as string) || "search",
      input: (args?.input as string) || "",
      context: args?.context as string | undefined,
      mode: args?.mode as string | undefined,
      canon_url: canonUrl,
      include_metadata: includeMetadata,
      state: args?.state as any,
      env,
    });
  }

  // Layer 2: Individual tools — stateless, route to same handlers
  // Extract the action name from the tool name (oddkit_orient → orient)
  const actionFromName: Record<string, string> = {
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
    oddkit_cleanup_storage: "cleanup_storage",
  };

  const action = actionFromName[name];
  if (action) {
    return handleUnifiedAction({
      action,
      input: (args?.input as string) || "",
      context: args?.context as string | undefined,
      mode: args?.mode as string | undefined,
      canon_url: canonUrl,
      include_metadata: includeMetadata,
      // No state for individual tools
      env,
    });
  }

  throw new Error(`Unknown tool: ${name}`);
}

// ──────────────────────────────────────────────────────────────────────────────
// MCP request handler
// ──────────────────────────────────────────────────────────────────────────────

interface McpResponse {
  jsonrpc: string;
  id?: unknown;
  result?: unknown;
  error?: unknown;
  _sessionId?: string;
}

async function handleMcpRequest(
  body: unknown,
  env: Env,
  sessionId?: string,
): Promise<McpResponse> {
  const request = body as {
    jsonrpc: string;
    id?: unknown;
    method: string;
    params?: unknown;
  };

  const { method, params, id } = request;

  try {
    switch (method) {
      case "initialize": {
        const newSessionId = generateSessionId();
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            serverInfo: getServerInfo(env.ODDKIT_VERSION),
            capabilities: {
              tools: {},
              resources: {},
              prompts: {},
            },
            instructions:
              "oddkit provides epistemic governance — policy retrieval, completion validation, and decision capture. Use the unified `oddkit` tool with action parameter for multi-step workflows with state threading, or use individual tools (oddkit_search, oddkit_orient, oddkit_challenge, etc.) for direct, stateless calls.",
          },
          _sessionId: newSessionId,
        };
      }

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: { tools: ALL_TOOLS },
        };

      case "resources/list":
        return {
          jsonrpc: "2.0",
          id,
          result: { resources: RESOURCES },
        };

      case "resources/read": {
        const { uri } = params as { uri: string };
        const content = getResourceContent(uri);

        if (!content) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: `Unknown resource: ${uri}` },
          };
        }

        return {
          jsonrpc: "2.0",
          id,
          result: {
            contents: [{ uri, mimeType: "text/plain", text: content }],
          },
        };
      }

      case "prompts/list": {
        const registry = await fetchPromptsRegistry(env.BASELINE_URL);
        if (!registry) {
          return { jsonrpc: "2.0", id, result: { prompts: [] } };
        }

        const prompts = registry.instructions
          .filter((inst) => inst.audience === "agent")
          .map((inst) => ({
            name: inst.id,
            description: `Agent: ${inst.id} (${inst.uri})`,
          }));

        return { jsonrpc: "2.0", id, result: { prompts } };
      }

      case "prompts/get": {
        const { name } = params as { name: string };
        const registry = await fetchPromptsRegistry(env.BASELINE_URL);

        if (!registry) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "Failed to load prompts registry" },
          };
        }

        const instruction = registry.instructions.find((i) => i.id === name);
        if (!instruction) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: `Unknown prompt: ${name}` },
          };
        }

        const content = await fetchPromptContent(env.BASELINE_URL, instruction.path);
        if (!content) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: `Failed to fetch prompt content: ${instruction.path}` },
          };
        }

        return {
          jsonrpc: "2.0",
          id,
          result: {
            description: `Agent: ${instruction.id}`,
            messages: [
              { role: "user", content: { type: "text", text: content } },
            ],
          },
        };
      }

      case "tools/call": {
        const { name, arguments: args } = params as {
          name: string;
          arguments?: Record<string, unknown>;
        };

        let result: OddkitEnvelope;
        try {
          result = await Promise.race([
            executeToolCall(name, args, env),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error(`Tool '${name}' timed out after ${MCP_TOOL_TIMEOUT_MS}ms`)),
                MCP_TOOL_TIMEOUT_MS,
              ),
            ),
          ]);
        } catch (toolErr) {
          const message = toolErr instanceof Error ? toolErr.message : "Tool execution failed";
          const code = message.startsWith("Unknown tool:") ? -32601 : -32603;
          return { jsonrpc: "2.0", id, error: { code, message } };
        }

        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              { type: "text", text: JSON.stringify(result, null, 2) },
            ],
          },
        };
      }

      case "notifications/initialized":
        return { jsonrpc: "2.0" };

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: err instanceof Error ? err.message : "Internal error",
      },
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// HTTP handler
// ──────────────────────────────────────────────────────────────────────────────

function corsHeaders(origin: string = "*"): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, Last-Event-ID",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
  };
}

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
            protocolVersion: PROTOCOL_VERSION,
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

    // MCP endpoint — SSE contract (DO NOT change without updating tests)
    //
    // The MCP 2025-03-26 spec defines two response formats:
    //   1. JSON:  Content-Type: application/json  (single response)
    //   2. SSE:   Content-Type: text/event-stream (streaming, supports batches)
    //
    // When the client includes "text/event-stream" in Accept, the server
    // MUST respond with SSE — even if "application/json" is also listed.
    // Real MCP clients (Claude Desktop, Claude Code) send:
    //   Accept: application/json, text/event-stream
    // and expect SSE back. Preferring JSON breaks them.
    //
    // GET /mcp behavior:
    //   - With Accept: text/event-stream → return SSE stream (test 4c)
    //   - Without text/event-stream     → return 405        (test 4d)
    //
    // POST /mcp behavior:
    //   - With Accept containing text/event-stream → SSE (tests 4f, 4g, 4h)
    //   - Without text/event-stream                → JSON (all other tests)
    //
    // See: tests/cloudflare-production.test.sh tests 4c, 4d, 4f, 4g, 4h
    if (url.pathname === "/mcp") {
      const acceptHeader = request.headers.get("Accept") || "";
      // DO NOT add `&& !acceptHeader.includes("application/json")` here.
      // MCP clients send both; SSE takes priority when present.
      const wantsSSE = acceptHeader.includes("text/event-stream");
      const sessionId = request.headers.get("Mcp-Session-Id") || undefined;

      // GET /mcp: Only valid with Accept: text/event-stream (test 4c).
      // Without it, return 405 (test 4d).
      // DO NOT return 405 for ALL GETs — that breaks SSE-capable clients.
      if (request.method === "GET") {
        if (!wantsSSE) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32000, message: "Method not allowed. Use POST for JSON-RPC or GET with Accept: text/event-stream." },
            }),
            {
              status: 405,
              headers: { Allow: "POST", "Content-Type": "application/json", ...corsHeaders(origin) },
            },
          );
        }

        // Stateless server — no server-initiated notifications to push.
        // Return a minimal SSE stream that closes immediately.
        //
        // BUG FIX: controller.close() is CRITICAL. Without it the
        // ReadableStream stays open forever, creating a zombie connection
        // that hangs MCP clients. This was the root cause of the original
        // "MCP HTTP hanging" bug. DO NOT remove controller.close().
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(": connected\n\n"));
            controller.close(); // ← MUST close. Removing this causes hanging.
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
            ...corsHeaders(origin),
          },
        });
      }

      if (request.method === "DELETE") {
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
      }

      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405, headers: corsHeaders(origin) });
      }

      try {
        const body = await request.json();
        const isBatch = Array.isArray(body);
        const messages = isBatch ? (body as unknown[]) : [body];

        const responses: McpResponse[] = [];
        let initSessionId: string | undefined;

        for (const msg of messages) {
          const resp = await handleMcpRequest(msg, env, sessionId || initSessionId);
          if (resp._sessionId) initSessionId = resp._sessionId;
          delete resp._sessionId;
          if (resp.id !== undefined || resp.error) responses.push(resp);
        }

        const responseHeaders: Record<string, string> = { ...corsHeaders(origin) };
        const effectiveSessionId = initSessionId || sessionId;
        if (effectiveSessionId) responseHeaders["Mcp-Session-Id"] = effectiveSessionId;

        if (responses.length === 0) {
          return new Response(null, { status: 202, headers: responseHeaders });
        }

        // Return SSE when client accepts it (tests 4f, 4g, 4h).
        // DO NOT add `&& !acceptHeader.includes("application/json")` — MCP
        // clients send "Accept: application/json, text/event-stream" and
        // expect SSE. Adding that guard causes tests 4f, 4g, 4h to fail.
        if (wantsSSE) {
          responseHeaders["Content-Type"] = "text/event-stream";
          responseHeaders["Cache-Control"] = "no-cache";
          let sseBody = "";
          for (const resp of responses) sseBody += formatSseEvent(resp);
          return new Response(sseBody, { status: 200, headers: responseHeaders });
        }

        responseHeaders["Content-Type"] = "application/json";
        const jsonBody = isBatch || responses.length > 1
          ? JSON.stringify(responses)
          : JSON.stringify(responses[0]);
        return new Response(jsonBody, { headers: responseHeaders });
      } catch (err) {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }),
          { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders(origin) } },
        );
      }
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
