/**
 * oddkit MCP Worker
 *
 * Remote MCP server for oddkit, deployable to Cloudflare Workers.
 * Provides policy retrieval and completion validation for Claude.ai.
 *
 * Uses streamable-http transport for MCP communication.
 */

import { runOrchestrate, runOrientAction, runChallengeAction, runGateAction, runEncodeAction, type OrchestrateResult, type Env } from "./orchestrate";
import { renderChatPage } from "./chat-ui";
import { handleChatRequest } from "./chat-api";
import pkg from "../package.json";

export type { Env };

// Tool definitions
const TOOLS = [
  {
    name: "oddkit_orchestrate",
    description: `Routes a message to librarian/validate/explain and returns tool-grade JSON with ready-to-send assistant_text.

MUST: Before editing files or implementing a spec, call with your implementation plan.
MUST: Before claiming done/fixed/shipped/merged, call with completion claim + artifact paths.

Use when:
- Policy/canon questions ("what's the rule?", "is this allowed?")
- Pre-implementation guidance ("preflight: add authentication")
- Completion validation ("done: implemented X with screenshot Y")
- Discovery ("what's in ODD?", "list canon")`,
    inputSchema: {
      type: "object" as const,
      properties: {
        message: { type: "string", description: "The message to process" },
        action: {
          type: "string",
          enum: ["orient", "challenge", "gate", "encode", "catalog", "preflight", "librarian", "validate", "explain"],
          description: "Explicit action override (optional, auto-detected from message)",
        },
        canon_url: {
          type: "string",
          description: "Optional: GitHub repo URL for canon override (e.g., https://github.com/org/repo). Canon docs override klappy.dev baseline.",
        },
      },
      required: ["message"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "oddkit_librarian",
    description: "Retrieves governing/operational docs with quotes + citations.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "The policy question to answer" },
        canon_url: {
          type: "string",
          description: "Optional: GitHub repo URL for canon override",
        },
      },
      required: ["query"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "oddkit_validate",
    description: "Validates completion claims against required artifacts.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message: { type: "string", description: "The completion claim with artifact references" },
      },
      required: ["message"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "oddkit_catalog",
    description: "Lists available documentation with categories and counts.",
    inputSchema: {
      type: "object" as const,
      properties: {
        canon_url: {
          type: "string",
          description: "Optional: GitHub repo URL for canon override",
        },
      },
      required: [] as string[],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "oddkit_invalidate_cache",
    description: "Force refresh of cached baseline/canon data.",
    inputSchema: {
      type: "object" as const,
      properties: {
        canon_url: {
          type: "string",
          description: "Optional: GitHub repo URL to invalidate cache for",
        },
      },
      required: [] as string[],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "oddkit_orient",
    description: `Assess a goal, idea, or situation against epistemic modes (exploration/planning/execution).

Determines which mode the user is in based on their input. Surfaces unresolved items, unstated assumptions, and questions that need answering before progressing.

Use when:
- Starting a new task or conversation and need to understand where you are
- Uncertain whether to explore, plan, or execute
- Want to surface hidden assumptions before committing to a direction

Returns: current mode, confidence, unresolved items, assumptions detected, suggested next questions, relevant canon references.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        input: {
          type: "string",
          description: "A goal, idea, or situation description to orient against.",
        },
        canon_url: {
          type: "string",
          description: "Optional: GitHub repo URL for canon override.",
        },
      },
      required: ["input"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "oddkit_challenge",
    description: `Pressure-test a claim, assumption, or proposal against canon constraints.

Queries canon for relevant constraints and surfaces tensions, missing evidence, unexamined risks, and contradictions. Applies challenge proportionally — stronger claims get harder scrutiny.

Use when:
- Evaluating a proposal before committing
- Testing whether an assumption holds under scrutiny
- Checking if a claim has sufficient evidence
- Want to find what could go wrong before it does

Returns: claim type, tensions with canon, missing prerequisites, proportional challenges, suggested reframings, relevant canon constraints.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        input: {
          type: "string",
          description: "A claim, assumption, or proposal to challenge.",
        },
        mode: {
          type: "string",
          enum: ["exploration", "planning", "execution"],
          description: "Optional epistemic mode context for proportional challenge.",
        },
        canon_url: {
          type: "string",
          description: "Optional: GitHub repo URL for canon override.",
        },
      },
      required: ["input"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "oddkit_gate",
    description: `Check transition prerequisites before changing epistemic modes.

Validates that a proposed transition (e.g., "ready to build", "moving to planning") has met its prerequisites. Surfaces unmet requirements, missing evidence, and what would need to be true to proceed. Blocks premature convergence.

Use when:
- About to shift from exploration to planning
- About to shift from planning to execution
- Claiming readiness to ship or deploy
- Wanting to step back from execution to rethink

Returns: gate status (PASS/NOT_READY), transition details, met/unmet/unknown prerequisites, missing evidence, relevant canon references.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        input: {
          type: "string",
          description: "The proposed transition (e.g., 'ready to build', 'moving to planning').",
        },
        context: {
          type: "string",
          description: "Optional context about what's been decided so far.",
        },
        canon_url: {
          type: "string",
          description: "Optional: GitHub repo URL for canon override.",
        },
      },
      required: ["input"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "oddkit_encode",
    description: `Structure a decision, insight, or boundary as a durable record.

Validates that the input has sufficient justification and clarity to prevent future re-litigation. Structures it as a decision artifact with title, rationale, constraints, and status. Assesses quality and suggests improvements.

Use when:
- A decision has been made and needs to be recorded
- An insight or lesson learned should be preserved
- A boundary or constraint has been established
- Want to prevent the same debate from recurring

Returns: structured decision artifact, quality assessment (strong/adequate/weak/insufficient), gaps and improvement suggestions, relevant canon references.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        input: {
          type: "string",
          description: "A decision, insight, or boundary to capture.",
        },
        context: {
          type: "string",
          description: "Optional supporting context.",
        },
        canon_url: {
          type: "string",
          description: "Optional: GitHub repo URL for canon override.",
        },
      },
      required: ["input"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

// Resource definitions
const RESOURCES = [
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
];

// Resource content
function getInstructionsResource(): string {
  return `ODDKIT DECISION GATE

You have access to oddkit for epistemic governance.

CALL oddkit_orchestrate WHEN:
1. About to implement something → preflight first
2. Have a policy/rules question → ask librarian
3. Claiming completion → validate with artifacts
4. Need to understand available docs → catalog

DO NOT CALL WHEN:
- Simple file operations with no policy implications
- Continuing work already preflighted
- User explicitly says to skip

The tool returns ready-to-use assistant_text with citations.`;
}

function getQuickStartResource(): string {
  return `ODDKIT QUICK START FOR AGENTS

You have access to oddkit_orchestrate for policy retrieval and completion validation.

THREE CRITICAL MOMENTS TO CALL ODDKIT:

1. BEFORE IMPLEMENTING
   Call: oddkit_orchestrate({ message: "preflight: <what you're implementing>" })
   Returns: Start here / Constraints / Definition of Done / Pitfalls

2. WHEN YOU HAVE QUESTIONS
   Call: oddkit_orchestrate({ message: "<your question>" })
   Returns: Answer with citations and evidence quotes

3. BEFORE CLAIMING DONE
   Call: oddkit_orchestrate({ message: "done: <what you completed>" })
   Returns: VERIFIED or NEEDS_ARTIFACTS with missing evidence list

RESPONSE HANDLING:
- Use the "assistant_text" field from the response directly
- It contains a complete answer with citations
- Don't add extra narration - the text is ready to use

COMMON PATTERNS:
- Policy question: { "message": "What is the definition of done?" }
- Preflight: { "message": "preflight: add user authentication" }
- Validate: { "message": "done: implemented login. Screenshot: login.png" }
- Discovery: { "message": "What's in ODD?" }

IMPORTANT: Never pre-inject large documents. Always retrieve on-demand via oddkit.`;
}

function getExamplesResource(): string {
  return `ODDKIT USAGE EXAMPLES

=== PREFLIGHT (before implementing) ===

Request:
{
  "message": "preflight: implement user authentication with OAuth"
}

Response includes:
- Start here: files to read first
- Constraints: rules that apply
- Definition of Done: what completion looks like
- Pitfalls: common mistakes to avoid


=== POLICY QUESTION ===

Request:
{
  "message": "What evidence is required for UI changes?"
}

Response includes:
- Answer with 2-4 substantial quotes
- Citations (file#section format)
- Read next suggestions


=== COMPLETION VALIDATION ===

Request:
{
  "message": "done: implemented search feature with tests. Screenshot: search.png, Test output: npm test passed"
}

Response verdict:
- VERIFIED: All required evidence provided
- NEEDS_ARTIFACTS: Lists what's missing


=== DISCOVERY (what's available) ===

Request:
{
  "message": "What's in ODD? Show me the canon."
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
  "action": "preflight"
}

Valid actions: preflight, catalog, librarian, validate, explain, orient`;
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

// Prompt registry interface
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

// Fetch prompts registry from GitHub
async function fetchPromptsRegistry(baselineUrl: string): Promise<PromptRegistry | null> {
  try {
    const response = await fetch(`${baselineUrl}/canon/instructions/REGISTRY.json`);
    if (!response.ok) return null;
    return (await response.json()) as PromptRegistry;
  } catch {
    return null;
  }
}

// Fetch prompt content from GitHub
async function fetchPromptContent(baselineUrl: string, path: string): Promise<string | null> {
  try {
    const response = await fetch(`${baselineUrl}/${path}`);
    if (!response.ok) return null;
    const content = await response.text();
    // Strip YAML frontmatter if present
    return content.replace(/^---[\s\S]*?---\n/, "").trim();
  } catch {
    return null;
  }
}

// Protocol version - using 2025-03-26 for Streamable HTTP transport
const PROTOCOL_VERSION = "2025-03-26";

// Build-time version from package.json — baked into the bundle by wrangler/esbuild.
// MCP Implementation schema requires { name: string, version: string } — both mandatory.
// Previously relied on ODDKIT_VERSION env var which was undefined in production,
// causing JSON.stringify to silently drop it → strict validation failure → 424.
const BUILD_VERSION = pkg.version;

// Server info — MCP Implementation schema: { name, version } only.
// protocolVersion belongs at the top level of InitializeResult, not inside serverInfo.
function getServerInfo(envVersion: string | undefined) {
  return {
    name: "oddkit",
    version: envVersion || BUILD_VERSION,
  };
}

// Generate a unique session ID
function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `oddkit-${timestamp}-${random}`;
}

// Format a JSON-RPC response as an SSE event.
// Uses "event: message" explicitly for maximum client compatibility.
function formatSseEvent(data: unknown, eventId?: string): string {
  const lines: string[] = [];
  if (eventId) {
    lines.push(`id: ${eventId}`);
  }
  lines.push("event: message");
  lines.push(`data: ${JSON.stringify(data)}`);
  lines.push(""); // Empty line to end the event
  return lines.join("\n") + "\n";
}

// MCP request/response types with session tracking
interface McpResponse {
  jsonrpc: string;
  id?: unknown;
  result?: unknown;
  error?: unknown;
  _sessionId?: string; // Internal: session ID to return in header
}

// Handle MCP JSON-RPC requests
async function handleMcpRequest(
  body: unknown,
  env: Env,
  sessionId?: string
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
        // Generate new session ID for this connection
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
            instructions: "oddkit provides epistemic governance — policy retrieval, completion validation, and decision capture. Use oddkit_orchestrate before implementing changes (preflight), when you have policy questions (librarian), and before claiming completion (validate).",
          },
          _sessionId: newSessionId,
        };
      }

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: { tools: TOOLS },
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
            error: {
              code: -32602,
              message: `Unknown resource: ${uri}`,
            },
          };
        }

        return {
          jsonrpc: "2.0",
          id,
          result: {
            contents: [
              {
                uri,
                mimeType: "text/plain",
                text: content,
              },
            ],
          },
        };
      }

      case "prompts/list": {
        const registry = await fetchPromptsRegistry(env.BASELINE_URL);
        if (!registry) {
          return {
            jsonrpc: "2.0",
            id,
            result: { prompts: [] },
          };
        }

        const prompts = registry.instructions
          .filter((inst) => inst.audience === "agent")
          .map((inst) => ({
            name: inst.id,
            description: `Agent: ${inst.id} (${inst.uri})`,
          }));

        return {
          jsonrpc: "2.0",
          id,
          result: { prompts },
        };
      }

      case "prompts/get": {
        const { name } = params as { name: string };
        const registry = await fetchPromptsRegistry(env.BASELINE_URL);

        if (!registry) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32602,
              message: "Failed to load prompts registry",
            },
          };
        }

        const instruction = registry.instructions.find((i) => i.id === name);
        if (!instruction) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32602,
              message: `Unknown prompt: ${name}`,
            },
          };
        }

        const content = await fetchPromptContent(env.BASELINE_URL, instruction.path);
        if (!content) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32602,
              message: `Failed to fetch prompt content: ${instruction.path}`,
            },
          };
        }

        return {
          jsonrpc: "2.0",
          id,
          result: {
            description: `Agent: ${instruction.id}`,
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: content,
                },
              },
            ],
          },
        };
      }

      case "tools/call": {
        const { name, arguments: args } = params as {
          name: string;
          arguments?: Record<string, unknown>;
        };

        let result: OrchestrateResult;
        const canonUrl = args?.canon_url as string | undefined;

        switch (name) {
          case "oddkit_orchestrate":
            result = await runOrchestrate({
              message: (args?.message as string) || "",
              action: args?.action as string | undefined,
              env,
              canonUrl,
            });
            break;

          case "oddkit_librarian":
            result = await runOrchestrate({
              message: (args?.query as string) || "",
              action: "librarian",
              env,
              canonUrl,
            });
            break;

          case "oddkit_validate":
            result = await runOrchestrate({
              message: (args?.message as string) || "",
              action: "validate",
              env,
              canonUrl,
            });
            break;

          case "oddkit_catalog":
            result = await runOrchestrate({
              message: "what's in odd",
              action: "catalog",
              env,
              canonUrl,
            });
            break;

          case "oddkit_invalidate_cache": {
            // Import the fetcher to invalidate cache
            const { ZipBaselineFetcher } = await import("./zip-baseline-fetcher");
            const fetcher = new ZipBaselineFetcher(env);
            await fetcher.invalidateCache(canonUrl);
            result = {
              action: "invalidate_cache",
              result: { success: true, canon_url: canonUrl },
              assistant_text: `Cache invalidated${canonUrl ? ` for ${canonUrl}` : ""}. Next request will fetch fresh data.`,
            };
            break;
          }

          case "oddkit_orient":
            result = await runOrientAction({
              input: (args?.input as string) || "",
              env,
              canonUrl,
            });
            break;

          case "oddkit_challenge":
            result = await runChallengeAction({
              input: (args?.input as string) || "",
              mode: args?.mode as string | undefined,
              env,
              canonUrl,
            });
            break;

          case "oddkit_gate":
            result = await runGateAction({
              input: (args?.input as string) || "",
              context: args?.context as string | undefined,
              env,
              canonUrl,
            });
            break;

          case "oddkit_encode":
            result = await runEncodeAction({
              input: (args?.input as string) || "",
              context: args?.context as string | undefined,
              env,
              canonUrl,
            });
            break;

          default:
            return {
              jsonrpc: "2.0",
              id,
              error: {
                code: -32601,
                message: `Unknown tool: ${name}`,
              },
            };
        }

        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          },
        };
      }

      case "notifications/initialized":
        // Notification, no response needed
        return { jsonrpc: "2.0" };

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`,
          },
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

// CORS headers for MCP Streamable HTTP transport
function corsHeaders(origin: string = "*"): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, Last-Event-ID",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
  };
}

/**
 * Main fetch handler
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "*";

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    // Chat UI at root
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(renderChatPage(), {
        headers: {
          "Content-Type": "text/html;charset=utf-8",
          "Cache-Control": "no-cache",
          "Link": `<${url.origin}/mcp>; rel="mcp-server-url", <${url.origin}/.well-known/mcp.json>; rel="mcp-server-card"`,
          ...corsHeaders(origin),
        },
      });
    }

    // Chat API endpoint
    if (url.pathname === "/api/chat" && request.method === "POST") {
      return handleChatRequest(request, env);
    }

    // MCP discovery endpoint (.well-known/mcp.json)
    // SEP-1649: MCP Server Cards - enables clients to discover MCP endpoint
    // without establishing a connection or requiring manual configuration
    if (url.pathname === "/.well-known/mcp.json" && request.method === "GET") {
      const serverCard = {
        mcpServers: {
          oddkit: {
            url: `${url.origin}/mcp`,
            name: "oddkit",
            version: env.ODDKIT_VERSION || BUILD_VERSION,
            description: "Epistemic governance — policy retrieval, completion validation, and decision capture",
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {
              tools: {},
              resources: {},
              prompts: {},
            },
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
          endpoints: {
            chat: "/",
            api: "/api/chat",
            mcp: "/mcp",
            health: "/health",
          },
          capabilities: ["chat", "tools", "resources", "prompts"],
        }),
        {
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders(origin),
          },
        }
      );
    }

    // MCP endpoint - streamable HTTP transport
    if (url.pathname === "/mcp") {
      const acceptHeader = request.headers.get("Accept") || "";
      const wantsSSE = acceptHeader.includes("text/event-stream");
      const sessionId = request.headers.get("Mcp-Session-Id") || undefined;

      // Handle GET requests for SSE streaming (server-initiated messages)
      if (request.method === "GET") {
        if (!wantsSSE) {
          // MCP spec: GET without Accept: text/event-stream MUST return 405.
          // Returning JSON here confuses clients into thinking this is the
          // legacy HTTP+SSE transport, breaking tool discovery.
          return new Response("Method Not Allowed. Use POST for JSON-RPC or GET with Accept: text/event-stream for SSE.\nDiscovery: GET /.well-known/mcp.json", {
            status: 405,
            headers: {
              Allow: "POST",
              ...corsHeaders(origin),
            },
          });
        }

        // For now, return an SSE stream that stays open but sends no events
        // This satisfies clients that open GET connections for server notifications
        // In the future, this could be used for progress updates on long-running operations
        const stream = new ReadableStream({
          start(controller) {
            // Send a comment to keep the connection alive
            controller.enqueue(new TextEncoder().encode(": connected\n\n"));
          },
          cancel() {
            // Client closed the connection
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
            ...corsHeaders(origin),
          },
        });
      }

      // Handle DELETE for session termination
      if (request.method === "DELETE") {
        // Session terminated - acknowledge it
        return new Response(null, {
          status: 204,
          headers: corsHeaders(origin),
        });
      }

      // POST requests for JSON-RPC
      if (request.method !== "POST") {
        return new Response("Method not allowed", {
          status: 405,
          headers: corsHeaders(origin),
        });
      }

      try {
        const body = await request.json();

        // MCP spec: body can be a single JSON-RPC message or a batch (array).
        const isBatch = Array.isArray(body);
        const messages = isBatch ? (body as unknown[]) : [body];

        // Process all messages, collecting responses for requests (not notifications).
        const responses: McpResponse[] = [];
        let initSessionId: string | undefined;

        for (const msg of messages) {
          const resp = await handleMcpRequest(msg, env, sessionId || initSessionId);

          // Track session ID from initialize
          if (resp._sessionId) {
            initSessionId = resp._sessionId;
          }
          delete resp._sessionId;

          // Only collect responses for requests (have id) or errors.
          // Notifications (no id, no error) are acknowledged but produce no response.
          if (resp.id !== undefined || resp.error) {
            responses.push(resp);
          }
        }

        // Build common response headers
        const responseHeaders: Record<string, string> = {
          ...corsHeaders(origin),
        };

        if (initSessionId) {
          responseHeaders["Mcp-Session-Id"] = initSessionId;
        }

        // All notifications, no requests → 202 Accepted with no body.
        // (Not 204 — strict clients like ChatGPT require exactly 202.)
        if (responses.length === 0) {
          return new Response(null, {
            status: 202,
            headers: responseHeaders,
          });
        }

        // MCP Streamable HTTP: the server MUST return either text/event-stream (SSE)
        // or application/json. OpenAI Agent Builder requires SSE responses for POST.
        // Prefer SSE when the client accepts it for maximum compatibility.
        if (wantsSSE) {
          responseHeaders["Content-Type"] = "text/event-stream";
          responseHeaders["Cache-Control"] = "no-cache";

          let sseBody = "";
          for (const resp of responses) {
            sseBody += formatSseEvent(resp);
          }

          return new Response(sseBody, {
            status: 200,
            headers: responseHeaders,
          });
        }

        // Fallback: application/json for clients that don't accept SSE.
        responseHeaders["Content-Type"] = "application/json";

        // Batch request → array response; single request → single object.
        const jsonBody = (isBatch || responses.length > 1)
          ? JSON.stringify(responses)
          : JSON.stringify(responses[0]);

        return new Response(jsonBody, {
          headers: responseHeaders,
        });
      } catch (err) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32700,
              message: "Parse error",
            },
          }),
          {
            status: 400,
            headers: {
              "Content-Type": "application/json",
              ...corsHeaders(origin),
            },
          }
        );
      }
    }

    return new Response("Not found", {
      status: 404,
      headers: corsHeaders(origin),
    });
  },
};
