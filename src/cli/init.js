/**
 * oddkit init command
 *
 * Sets up MCP configuration for Cursor (global or project-local).
 * Merges safely - never overwrites unrelated servers.
 *
 * Usage:
 *   oddkit init           - Write global Cursor config (~/.cursor/mcp.json)
 *   oddkit init --project - Write project-local config (<repo>/.cursor/mcp.json)
 *   oddkit init --print   - Print JSON snippet only (no file writes)
 *   oddkit init --force   - Replace existing oddkit entry if different
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

/**
 * Default oddkit server spec for MCP
 */
const ODDKIT_SERVER_SPEC = {
  command: "npx",
  args: ["oddkit-mcp"],
  env: {},
};

/**
 * Resolve repository root by walking up from cwd looking for .git
 */
export function resolveRepoRoot(startDir = process.cwd()) {
  let current = startDir;
  const root = dirname(current);

  while (current !== root) {
    if (existsSync(join(current, ".git"))) {
      return current;
    }
    current = dirname(current);
  }

  // Check root
  if (existsSync(join(current, ".git"))) {
    return current;
  }

  // Fallback to cwd
  return startDir;
}

/**
 * Resolve global Cursor MCP config path
 */
export function resolveCursorGlobalMcpPath() {
  return join(homedir(), ".cursor", "mcp.json");
}

/**
 * Resolve project-local Cursor MCP config path
 */
export function resolveCursorProjectMcpPath(repoRoot) {
  return join(repoRoot, ".cursor", "mcp.json");
}

/**
 * Read JSON from file if it exists, return empty object if not
 * Throws on invalid JSON with clear message
 */
export function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    // Handle empty files
    if (!content.trim()) {
      return {};
    }
    return JSON.parse(content);
  } catch (err) {
    throw new Error(
      `Invalid JSON in ${filePath}. Fix it manually or run with --print to see the snippet.\n` +
        `Parse error: ${err.message}`,
    );
  }
}

/**
 * Ensure parent directory exists
 */
export function ensureDirExists(filePath) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Check if two server specs are identical
 */
function specsAreEqual(a, b) {
  if (!a || !b) return false;
  return (
    a.command === b.command &&
    JSON.stringify(a.args) === JSON.stringify(b.args) &&
    JSON.stringify(a.env || {}) === JSON.stringify(b.env || {})
  );
}

/**
 * Check if existing spec looks like an older oddkit entry
 */
function isOlderOddkitEntry(existing) {
  if (!existing) return false;
  // If it has oddkit-mcp in args or command, it's an oddkit entry
  const cmd = existing.command || "";
  const args = existing.args || [];
  return cmd.includes("oddkit") || args.some((a) => typeof a === "string" && a.includes("oddkit"));
}

/**
 * Merge oddkit server into existing config
 * Returns { merged, changed, message }
 */
export function mergeMcpServer(existing, serverName, serverSpec, force = false) {
  // Ensure we have the base structure
  const merged = { ...existing };
  if (!merged.mcpServers) {
    merged.mcpServers = {};
  }

  const existingServer = merged.mcpServers[serverName];

  // If no existing server, just add it
  if (!existingServer) {
    merged.mcpServers[serverName] = serverSpec;
    return {
      merged,
      changed: true,
      message: `Added ${serverName} server`,
    };
  }

  // If identical, no changes needed
  if (specsAreEqual(existingServer, serverSpec)) {
    return {
      merged,
      changed: false,
      message: `${serverName} server already configured (no changes needed)`,
    };
  }

  // Different - check if we should update
  if (force || isOlderOddkitEntry(existingServer)) {
    merged.mcpServers[serverName] = serverSpec;
    return {
      merged,
      changed: true,
      message: `Updated ${serverName} server`,
    };
  }

  // Different but no force - don't change
  return {
    merged,
    changed: false,
    message: `${serverName} server already exists and differs; use --force to replace`,
    conflict: true,
  };
}

/**
 * Write JSON with pretty formatting
 */
export function writeJsonPretty(filePath, obj) {
  ensureDirExists(filePath);
  writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\n", "utf-8");
}

/**
 * Generate the JSON snippet for oddkit MCP config
 */
export function getOddkitMcpSnippet() {
  return {
    mcpServers: {
      oddkit: ODDKIT_SERVER_SPEC,
    },
  };
}

/**
 * Run the init command
 */
export async function runInit(options = {}) {
  const { project, print, force, repo } = options;

  // Determine target path
  let targetPath;
  let targetType;

  if (project) {
    const repoRoot = repo || resolveRepoRoot();
    targetPath = resolveCursorProjectMcpPath(repoRoot);
    targetType = "project";
  } else {
    targetPath = resolveCursorGlobalMcpPath();
    targetType = "global";
  }

  // If --print, just output the snippet
  if (print) {
    const snippet = getOddkitMcpSnippet();
    return {
      success: true,
      action: "print",
      snippet,
      targetPath,
      targetType,
    };
  }

  // Read existing config
  let existing;
  try {
    existing = readJsonIfExists(targetPath);
  } catch (err) {
    return {
      success: false,
      action: "error",
      error: err.message,
      targetPath,
      targetType,
    };
  }

  // Merge
  const { merged, changed, message, conflict } = mergeMcpServer(
    existing,
    "oddkit",
    ODDKIT_SERVER_SPEC,
    force,
  );

  // If conflict and not forced, return without writing
  if (conflict) {
    return {
      success: false,
      action: "conflict",
      message,
      targetPath,
      targetType,
    };
  }

  // If no changes needed
  if (!changed) {
    return {
      success: true,
      action: "unchanged",
      message,
      targetPath,
      targetType,
    };
  }

  // Write merged config
  try {
    writeJsonPretty(targetPath, merged);
    return {
      success: true,
      action: "wrote",
      message,
      targetPath,
      targetType,
    };
  } catch (err) {
    return {
      success: false,
      action: "error",
      error: err.message,
      targetPath,
      targetType,
    };
  }
}
