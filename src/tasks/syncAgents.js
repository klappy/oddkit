/**
 * syncAgents.js - Diff, plan, and apply agent files from baseline to Cursor
 *
 * Safety rules (non-negotiable):
 * - Never writes into the baseline repo
 * - Never auto-runs on MCP calls
 * - Never overwrites without --apply AND printing patch plan first
 * - Always hashes bytes before/after
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from "fs";
import { join, basename } from "path";
import { createHash } from "crypto";
import { homedir } from "os";
import { ensureBaselineRepo, getBaselineRef } from "../baseline/ensureBaselineRepo.js";

/**
 * Compute SHA-256 hash of file contents (8-char prefix)
 */
function hashFile(filePath) {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

/**
 * Get default Cursor agents directory
 */
export function getDefaultCursorAgentsDir() {
  return join(homedir(), ".cursor", "agents");
}

/**
 * Get baseline agents directory from cache
 */
export function getBaselineAgentsDir(baselineRoot) {
  return join(baselineRoot, "canon", "agents");
}

/**
 * List agent files in a directory (*.md files starting with "odd-")
 */
function listAgentFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f.startsWith("odd-"))
    .sort();
}

/**
 * Build sync plan comparing baseline to destination
 *
 * @param {Object} options
 * @param {string} options.baselineRoot - Path to baseline repo root
 * @param {string} options.destDir - Destination directory (e.g., ~/.cursor/agents)
 * @param {string[]} [options.only] - Optional subset of agent names to sync
 * @returns {Object} Sync plan with actions
 */
export function buildSyncPlan({ baselineRoot, destDir, only = null }) {
  const baselineAgentsDir = getBaselineAgentsDir(baselineRoot);
  const baselineFiles = listAgentFiles(baselineAgentsDir);

  // Filter to requested subset if specified
  const targetFiles = only
    ? baselineFiles.filter((f) => only.some((name) => f === `${name}.md` || f === name))
    : baselineFiles;

  const plan = {
    baselineDir: baselineAgentsDir,
    destDir,
    actions: [],
    summary: {
      toAdd: 0,
      toUpdate: 0,
      unchanged: 0,
      total: targetFiles.length,
    },
  };

  for (const file of targetFiles) {
    const baselinePath = join(baselineAgentsDir, file);
    const destPath = join(destDir, file);
    const baselineHash = hashFile(baselinePath);
    const destHash = hashFile(destPath);

    const action = {
      file,
      baselinePath,
      destPath,
      baselineHash,
      destHash,
      action: null,
      reason: null,
    };

    if (!destHash) {
      action.action = "add";
      action.reason = "missing in destination";
      plan.summary.toAdd++;
    } else if (baselineHash !== destHash) {
      action.action = "update";
      action.reason = `hash mismatch (baseline: ${baselineHash}, dest: ${destHash})`;
      plan.summary.toUpdate++;
    } else {
      action.action = "unchanged";
      action.reason = `hashes match (${baselineHash})`;
      plan.summary.unchanged++;
    }

    plan.actions.push(action);
  }

  return plan;
}

/**
 * Format sync plan for human output
 */
export function formatSyncPlan(plan, { verbose = false } = {}) {
  const lines = [];

  lines.push("Agent Sync Plan");
  lines.push("===============");
  lines.push("");
  lines.push(`Source: ${plan.baselineDir}`);
  lines.push(`Destination: ${plan.destDir}`);
  lines.push("");

  // Summary
  lines.push("Summary:");
  lines.push(`  To add: ${plan.summary.toAdd}`);
  lines.push(`  To update: ${plan.summary.toUpdate}`);
  lines.push(`  Unchanged: ${plan.summary.unchanged}`);
  lines.push(`  Total: ${plan.summary.total}`);
  lines.push("");

  // Actions
  const toAdd = plan.actions.filter((a) => a.action === "add");
  const toUpdate = plan.actions.filter((a) => a.action === "update");
  const unchanged = plan.actions.filter((a) => a.action === "unchanged");

  if (toAdd.length > 0) {
    lines.push("Will ADD (missing in destination):");
    for (const a of toAdd) {
      lines.push(`  + ${a.file}`);
      if (verbose) lines.push(`      baseline: ${a.baselineHash}`);
    }
    lines.push("");
  }

  if (toUpdate.length > 0) {
    lines.push("Will UPDATE (content differs):");
    for (const a of toUpdate) {
      lines.push(`  ~ ${a.file}`);
      if (verbose) {
        lines.push(`      baseline: ${a.baselineHash}`);
        lines.push(`      current:  ${a.destHash}`);
      }
    }
    lines.push("");
  }

  if (verbose && unchanged.length > 0) {
    lines.push("UNCHANGED (already in sync):");
    for (const a of unchanged) {
      lines.push(`  = ${a.file} (${a.baselineHash})`);
    }
    lines.push("");
  }

  // Footer
  if (plan.summary.toAdd === 0 && plan.summary.toUpdate === 0) {
    lines.push("✓ All agents are in sync. Nothing to do.");
  } else {
    lines.push(`Run with --apply to copy ${plan.summary.toAdd + plan.summary.toUpdate} file(s).`);
  }

  return lines.join("\n");
}

/**
 * Apply sync plan (copy files)
 *
 * @param {Object} plan - Sync plan from buildSyncPlan
 * @param {Object} options
 * @param {boolean} [options.backup=true] - Create backups before overwriting
 * @returns {Object} Result with applied actions and backup info
 */
export function applySyncPlan(plan, { backup = true } = {}) {
  const result = {
    applied: [],
    backups: [],
    errors: [],
    backupDir: null,
  };

  // Ensure destination directory exists
  if (!existsSync(plan.destDir)) {
    mkdirSync(plan.destDir, { recursive: true });
  }

  // Create backup directory if needed
  if (backup) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    result.backupDir = join(plan.destDir, ".bak", timestamp);
  }

  const toApply = plan.actions.filter((a) => a.action === "add" || a.action === "update");

  for (const action of toApply) {
    try {
      // Backup existing file if updating
      if (backup && action.action === "update" && existsSync(action.destPath)) {
        if (!existsSync(result.backupDir)) {
          mkdirSync(result.backupDir, { recursive: true });
        }
        const backupPath = join(result.backupDir, action.file);
        copyFileSync(action.destPath, backupPath);
        result.backups.push({
          file: action.file,
          from: action.destPath,
          to: backupPath,
        });
      }

      // Copy from baseline to destination
      copyFileSync(action.baselinePath, action.destPath);

      // Verify copy
      const newHash = hashFile(action.destPath);
      if (newHash !== action.baselineHash) {
        result.errors.push({
          file: action.file,
          error: `Hash mismatch after copy (expected ${action.baselineHash}, got ${newHash})`,
        });
      } else {
        result.applied.push({
          file: action.file,
          action: action.action,
          hash: newHash,
        });
      }
    } catch (err) {
      result.errors.push({
        file: action.file,
        error: err.message,
      });
    }
  }

  return result;
}

/**
 * Format apply result for human output
 */
export function formatApplyResult(result) {
  const lines = [];

  lines.push("Agent Sync Applied");
  lines.push("==================");
  lines.push("");

  if (result.backupDir && result.backups.length > 0) {
    lines.push(`Backups created in: ${result.backupDir}`);
    for (const b of result.backups) {
      lines.push(`  📦 ${b.file}`);
    }
    lines.push("");
  }

  if (result.applied.length > 0) {
    lines.push("Applied:");
    for (const a of result.applied) {
      const icon = a.action === "add" ? "+" : "~";
      lines.push(`  ${icon} ${a.file} (${a.hash})`);
    }
    lines.push("");
  }

  if (result.errors.length > 0) {
    lines.push("Errors:");
    for (const e of result.errors) {
      lines.push(`  ✗ ${e.file}: ${e.error}`);
    }
    lines.push("");
  }

  if (result.errors.length === 0) {
    lines.push(`✓ Successfully synced ${result.applied.length} agent(s).`);
  } else {
    lines.push(`⚠ Completed with ${result.errors.length} error(s).`);
  }

  return lines.join("\n");
}

/**
 * Main sync-agents runner
 *
 * @param {Object} options
 * @param {boolean} [options.apply=false] - Actually apply changes
 * @param {boolean} [options.backup=true] - Create backups
 * @param {string[]} [options.only] - Subset of agents to sync
 * @param {boolean} [options.refreshBaseline=false] - Force baseline refresh
 * @param {string} [options.dest] - Override destination directory
 * @param {boolean} [options.verbose=false] - Verbose output
 * @returns {Object} Result with plan, apply result, and formatted output
 */
export async function runSyncAgents({
  apply = false,
  backup = true,
  only = null,
  refreshBaseline = false,
  dest = null,
  verbose = false,
} = {}) {
  // Ensure baseline is available (will refresh if needed)
  const baseline = await ensureBaselineRepo();
  if (!baseline.root) {
    return {
      ok: false,
      error: baseline.error || "Baseline not available",
      output: `Error: ${baseline.error || "Baseline not available"}`,
    };
  }

  const baselineRef = getBaselineRef();
  const destDir = dest || getDefaultCursorAgentsDir();

  // Build sync plan
  const plan = buildSyncPlan({
    baselineRoot: baseline.root,
    destDir,
    only,
  });

  // Add baseline info to output
  let output = "";
  output += `Baseline: ${baseline.baselineUrl} @ ${baselineRef}\n`;
  output += `Commit: ${baseline.commitSha || "unknown"}\n\n`;

  // Format plan
  output += formatSyncPlan(plan, { verbose });

  const result = {
    ok: true,
    baseline: {
      root: baseline.root,
      url: baseline.baselineUrl,
      ref: baselineRef,
      commit: baseline.commitSha,
    },
    plan,
    applied: null,
    output,
  };

  // Apply if requested
  if (apply && (plan.summary.toAdd > 0 || plan.summary.toUpdate > 0)) {
    const applyResult = applySyncPlan(plan, { backup });
    result.applied = applyResult;
    result.output += "\n\n" + formatApplyResult(applyResult);
    result.ok = applyResult.errors.length === 0;
  }

  return result;
}
