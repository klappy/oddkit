/**
 * oddkit init command
 *
 * Sets up MCP configuration for Cursor or Claude Code.
 * Merges safely - never overwrites unrelated servers.
 *
 * Usage:
 *   oddkit init              - Write global Cursor config (~/.cursor/mcp.json)
 *   oddkit init --claude     - Write Claude Code config (~/.claude.json)
 *   oddkit init --project    - Write project-local config (<repo>/.cursor/mcp.json or .mcp.json)
 *   oddkit init --print      - Print JSON snippet only (no file writes)
 *   oddkit init --force      - Replace existing oddkit entry if different
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

/**
 * Supported MCP targets
 */
export const MCP_TARGETS = {
  cursor: {
    name: "Cursor",
    globalPath: () => join(homedir(), ".cursor", "mcp.json"),
    projectPath: (repoRoot) => join(repoRoot, ".cursor", "mcp.json"),
  },
  claude: {
    name: "Claude Code",
    globalPath: () => join(homedir(), ".claude.json"),
    projectPath: (repoRoot) => join(repoRoot, ".mcp.json"),
  },
};

/**
 * Default oddkit server spec for MCP
 * Uses GitHub package reference for portable execution (no globals, no linking, no publishing)
 */
const ODDKIT_SERVER_SPEC = {
  command: "npx",
  args: ["--yes", "--package", "github:klappy/oddkit", "oddkit-mcp"],
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
  return MCP_TARGETS.cursor.globalPath();
}

/**
 * Resolve project-local Cursor MCP config path
 */
export function resolveCursorProjectMcpPath(repoRoot) {
  return MCP_TARGETS.cursor.projectPath(repoRoot);
}

/**
 * Resolve global Claude Code MCP config path
 */
export function resolveClaudeGlobalMcpPath() {
  return MCP_TARGETS.claude.globalPath();
}

/**
 * Resolve project-local Claude Code MCP config path
 */
export function resolveClaudeProjectMcpPath(repoRoot) {
  return MCP_TARGETS.claude.projectPath(repoRoot);
}

/**
 * Resolve MCP config path based on target and scope
 */
export function resolveMcpPath(target, scope, repoRoot) {
  const targetConfig = MCP_TARGETS[target];
  if (!targetConfig) {
    throw new Error(`Unknown MCP target: ${target}. Valid targets: ${Object.keys(MCP_TARGETS).join(", ")}`);
  }
  return scope === "project" ? targetConfig.projectPath(repoRoot) : targetConfig.globalPath();
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
 * Determine MCP target from options
 */
export function determineMcpTarget(options = {}) {
  // Explicit target flags take precedence
  if (options.claude) return "claude";
  if (options.cursor) return "cursor";

  // Auto-detect: if we're in a Claude Code session, default to claude
  if (process.env.CLAUDE_CODE || process.env.CLAUDE_SESSION_ID) {
    return "claude";
  }

  // Default to cursor for backward compatibility
  return "cursor";
}

/**
 * Run the init command
 */
export async function runInit(options = {}) {
  const { project, print, force, repo, all } = options;

  // If --all flag, configure all targets
  if (all) {
    return runInitAll(options);
  }

  // Determine target (cursor or claude)
  const target = determineMcpTarget(options);
  const targetConfig = MCP_TARGETS[target];
  const repoRoot = repo || resolveRepoRoot();

  // Determine target path
  let targetPath;
  let targetType;

  if (project) {
    targetPath = targetConfig.projectPath(repoRoot);
    targetType = "project";
  } else {
    targetPath = targetConfig.globalPath();
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
      target,
      targetName: targetConfig.name,
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
      target,
      targetName: targetConfig.name,
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
      target,
      targetName: targetConfig.name,
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
      target,
      targetName: targetConfig.name,
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
      target,
      targetName: targetConfig.name,
    };
  } catch (err) {
    return {
      success: false,
      action: "error",
      error: err.message,
      targetPath,
      targetType,
      target,
      targetName: targetConfig.name,
    };
  }
}

/**
 * Run init for all supported MCP targets
 */
export async function runInitAll(options = {}) {
  const { project, force, repo } = options;
  const repoRoot = repo || resolveRepoRoot();
  const results = [];

  for (const [targetKey, targetConfig] of Object.entries(MCP_TARGETS)) {
    const targetPath = project ? targetConfig.projectPath(repoRoot) : targetConfig.globalPath();
    const targetType = project ? "project" : "global";

    let existing;
    try {
      existing = readJsonIfExists(targetPath);
    } catch (err) {
      results.push({
        success: false,
        action: "error",
        error: err.message,
        targetPath,
        targetType,
        target: targetKey,
        targetName: targetConfig.name,
      });
      continue;
    }

    const { merged, changed, message, conflict } = mergeMcpServer(
      existing,
      "oddkit",
      ODDKIT_SERVER_SPEC,
      force,
    );

    if (conflict) {
      results.push({
        success: false,
        action: "conflict",
        message,
        targetPath,
        targetType,
        target: targetKey,
        targetName: targetConfig.name,
      });
      continue;
    }

    if (!changed) {
      results.push({
        success: true,
        action: "unchanged",
        message,
        targetPath,
        targetType,
        target: targetKey,
        targetName: targetConfig.name,
      });
      continue;
    }

    try {
      writeJsonPretty(targetPath, merged);
      results.push({
        success: true,
        action: "wrote",
        message,
        targetPath,
        targetType,
        target: targetKey,
        targetName: targetConfig.name,
      });
    } catch (err) {
      results.push({
        success: false,
        action: "error",
        error: err.message,
        targetPath,
        targetType,
        target: targetKey,
        targetName: targetConfig.name,
      });
    }
  }

  return {
    success: results.every((r) => r.success),
    action: "all",
    results,
  };
}
