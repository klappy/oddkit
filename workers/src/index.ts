/**
 * oddkit MCP Worker
 *
 * Remote MCP server for oddkit, deployable to Cloudflare Workers.
 * Provides policy retrieval and completion validation for Claude.ai.
 *
 * Uses streamable-http transport for MCP communication.
 */

import { runOrchestrate, type OrchestrateResult } from "./orchestrate";

export interface Env {
  BASELINE_URL: string;
  ODDKIT_VERSION: string;
  BASELINE_CACHE?: KVNamespace;
}

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
      },
    },
  },
  {
    name: "oddkit_librarian",
    description: "Retrieves governing/operational docs with quotes + citations.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "The policy question to answer" },
      },
      required: ["query"],
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
  },
];

// Server info
function getServerInfo(version: string) {
  return {
    name: "oddkit",
    version,
    protocolVersion: "2024-11-05",
  };
}

// Handle MCP JSON-RPC requests
async function handleMcpRequest(
  body: unknown,
  env: Env
): Promise<{ jsonrpc: string; id?: unknown; result?: unknown; error?: unknown }> {
  const request = body as {
    jsonrpc: string;
    id?: unknown;
    method: string;
    params?: unknown;
  };

  const { method, params, id } = request;

  try {
    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            serverInfo: getServerInfo(env.ODDKIT_VERSION),
            capabilities: {
              tools: {},
            },
          },
        };

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: { tools: TOOLS },
        };

      case "tools/call": {
        const { name, arguments: args } = params as {
          name: string;
          arguments?: Record<string, unknown>;
        };

        let result: OrchestrateResult;

        switch (name) {
          case "oddkit_orchestrate":
            result = await runOrchestrate({
              message: (args?.message as string) || "",
              action: args?.action as string | undefined,
              baselineUrl: env.BASELINE_URL,
              cache: env.BASELINE_CACHE,
            });
            break;

          case "oddkit_librarian":
            result = await runOrchestrate({
              message: (args?.query as string) || "",
              action: "librarian",
              baselineUrl: env.BASELINE_URL,
              cache: env.BASELINE_CACHE,
            });
            break;

          case "oddkit_validate":
            result = await runOrchestrate({
              message: (args?.message as string) || "",
              action: "validate",
              baselineUrl: env.BASELINE_URL,
              cache: env.BASELINE_CACHE,
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

// CORS headers
function corsHeaders(origin: string = "*"): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
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

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          ok: true,
          service: "oddkit-mcp",
          version: env.ODDKIT_VERSION,
          endpoints: {
            mcp: "/mcp",
            health: "/health",
          },
        }),
        {
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders(origin),
          },
        }
      );
    }

    // MCP endpoint - streamable HTTP
    if (url.pathname === "/mcp") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", {
          status: 405,
          headers: corsHeaders(origin),
        });
      }

      try {
        const body = await request.json();
        const response = await handleMcpRequest(body, env);

        // Don't return response for notifications
        if (!response.id && !response.error) {
          return new Response(null, {
            status: 204,
            headers: corsHeaders(origin),
          });
        }

        return new Response(JSON.stringify(response), {
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders(origin),
          },
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
