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
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { runOrchestrate } from "./orchestrate.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
 * Tool definitions
 */
const TOOLS = [
  {
    name: "oddkit_orchestrate",
    description:
      "Smart router for oddkit - automatically detects intent and routes to librarian (questions), validate (completion claims), or explain (explain requests). Recommended entrypoint for agents.",
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description:
            "The user message. Orchestrate will detect if it's a question, completion claim, or explain request.",
        },
        repoRoot: {
          type: "string",
          description: "Path to the repository root. Defaults to current working directory.",
        },
        baseline: {
          type: "string",
          description:
            "Override baseline repo (path or git URL). Defaults to klappy.dev canonical baseline.",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "oddkit_librarian",
    description:
      "Ask a policy or lookup question against ODD-governed documentation. Returns citations with quotes from governing documents.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The question to ask (e.g., 'What is the definition of done?')",
        },
        repoRoot: {
          type: "string",
          description: "Path to the repository root. Defaults to current working directory.",
        },
        baseline: {
          type: "string",
          description:
            "Override baseline repo (path or git URL). Defaults to klappy.dev canonical baseline.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "oddkit_validate",
    description:
      "Validate a completion claim. Returns verdict (PASS, NEEDS_ARTIFACTS, CLARIFY) with required evidence and gaps.",
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description:
            "The completion claim message (e.g., 'Done with the UI update. Screenshot: ui.png')",
        },
        repoRoot: {
          type: "string",
          description: "Path to the repository root. Defaults to current working directory.",
        },
        baseline: {
          type: "string",
          description:
            "Override baseline repo (path or git URL). Defaults to klappy.dev canonical baseline.",
        },
        artifacts: {
          type: "string",
          description: "Path to artifacts JSON file with additional evidence.",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "oddkit_explain",
    description:
      "Explain the last oddkit result in human-readable format. Shows what happened, why, and what to do next.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

/**
 * Create and start the MCP server
 */
async function main() {
  const server = new Server(
    {
      name: "oddkit",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // Handle list tools request
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: TOOLS,
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "oddkit_orchestrate": {
        const { message, repoRoot, baseline } = args;
        try {
          const result = await runOrchestrate({
            message,
            repoRoot: repoRoot || process.cwd(),
            baseline,
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
        const { query, repoRoot, baseline } = args;
        let cmd = `tool librarian -q "${query.replace(/"/g, '\\"')}"`;
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
        const { message, repoRoot, baseline, artifacts } = args;
        let cmd = `tool validate -m "${message.replace(/"/g, '\\"')}"`;
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

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  // Start server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("oddkit MCP server started");
}

main().catch((err) => {
  console.error("Failed to start MCP server:", err);
  process.exit(1);
});
