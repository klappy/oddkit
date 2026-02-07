/**
 * oddkit MCP Worker
 *
 * Remote MCP server for oddkit, deployable to Cloudflare Workers.
 * Provides policy retrieval and completion validation for Claude.ai.
 *
 * Uses streamable-http transport for MCP communication.
 */

import { runOrchestrate, type OrchestrateResult, type Env } from "./orchestrate";
import { renderChatPage } from "./chat-ui";
import { handleChatRequest } from "./chat-api";

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
          enum: ["orient", "catalog", "preflight", "librarian", "validate", "explain"],
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

// Server info
function getServerInfo(version: string) {
  return {
    name: "oddkit",
    version,
protocolVersion: PROTOCOL_VERSION,
  };
}

// Generate a unique session ID
function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `oddkit-${timestamp}-${random}`;
}

// Format a JSON-RPC response as an SSE event
function formatSseEvent(data: unknown, eventId?: string): string {
  const lines: string[] = [];
  if (eventId) {
    lines.push(`id: ${eventId}`);
  }
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
    "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id, Last-Event-ID",
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
            version: env.ODDKIT_VERSION,
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
          version: env.ODDKIT_VERSION,
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
          // Return MCP server metadata for plain GET requests (e.g. browser or client probing)
          // This helps clients discover the endpoint and understand how to connect
          return new Response(
            JSON.stringify({
              name: "oddkit",
              version: env.ODDKIT_VERSION,
              protocolVersion: PROTOCOL_VERSION,
              description: "Epistemic governance — policy retrieval, completion validation, and decision capture",
              transport: "streamable-http",
              capabilities: ["tools", "resources", "prompts"],
              usage: {
                initialize: "POST /mcp with JSON-RPC initialize request",
                sse: "GET /mcp with Accept: text/event-stream header",
                discovery: "GET /.well-known/mcp.json",
              },
            }, null, 2),
            {
              headers: {
                "Content-Type": "application/json",
                ...corsHeaders(origin),
              },
            }
          );
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
        const response = await handleMcpRequest(body, env, sessionId);

        // Extract session ID if set (for initialize response)
        const responseSessionId = response._sessionId;
        delete response._sessionId;

        // Don't return response for notifications
        if (!response.id && !response.error) {
          return new Response(null, {
            status: 204,
            headers: corsHeaders(origin),
          });
        }

        // Build response headers
        const responseHeaders: Record<string, string> = {
          "Content-Type": "application/json",
          ...corsHeaders(origin),
        };

        // Include session ID in header if this was an initialize response
        if (responseSessionId) {
          responseHeaders["Mcp-Session-Id"] = responseSessionId;
        }

        return new Response(JSON.stringify(response), {
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
