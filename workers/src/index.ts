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
              resources: {},
              prompts: {},
            },
          },
        };

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
          capabilities: ["tools", "resources", "prompts"],
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
