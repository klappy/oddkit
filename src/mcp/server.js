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
 * Tool definitions (tool-grade contracts; repo_root in schema for MCP clients)
 */
const ALL_TOOLS = [
  {
    name: "oddkit_orchestrate",
    description:
      "Routes a message to librarian/validate/explain and returns tool-grade JSON with ready-to-send assistant_text.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string" },
        repo_root: {
          type: "string",
          description: "Path to target repo. Default: current working directory.",
        },
        baseline: {
          type: "string",
          description: "Optional baseline git URL or local path.",
        },
      },
      required: ["message"],
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
      tools: getTools(),
    };
  });

  // Handle tool calls (normalize repo_root / repoRoot for backward compatibility)
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const repoRoot = args.repo_root ?? args.repoRoot ?? process.cwd();

    switch (name) {
      case "oddkit_orchestrate": {
        const { message, baseline } = args;
        try {
          const result = await runOrchestrate({
            message,
            repoRoot,
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
