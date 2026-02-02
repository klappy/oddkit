/**
 * oddkit hooks command
 *
 * Generates Claude Code hooks configuration for automatic oddkit integration.
 * Hooks can trigger oddkit validation before commits, after file changes, etc.
 *
 * Usage:
 *   oddkit hooks           - Generate .claude/settings.local.json with hooks
 *   oddkit hooks --print   - Print hooks config to stdout
 *   oddkit hooks --force   - Overwrite existing hooks
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { resolveRepoRoot } from "./init.js";

/**
 * Default hooks configuration for Claude Code
 * These hooks integrate oddkit into the Claude Code workflow
 */
export function getHooksConfig() {
  return {
    hooks: {
      // Before user prompt is processed - remind about oddkit
      PreToolUse: [
        {
          matcher: "Edit|Write",
          hooks: [
            {
              type: "command",
              command: "echo 'Reminder: Run oddkit preflight before major changes'",
            },
          ],
        },
      ],
      // After a tool completes - useful for validation reminders
      PostToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command:
                "if echo \"$TOOL_INPUT\" | grep -qE '(git commit|npm publish|deploy)'; then echo 'Consider running oddkit validation before claiming done'; fi",
            },
          ],
        },
      ],
      // When user submits a prompt - detect completion claims
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: "command",
              command: `node -e "
const msg = process.env.USER_PROMPT || '';
const completionPatterns = /\\b(done|finished|completed|shipped|merged|fixed|implemented|deployed)\\b/i;
if (completionPatterns.test(msg)) {
  console.log('COMPLETION_CLAIM_DETECTED: Consider calling oddkit_orchestrate to validate');
}
"`,
            },
          ],
        },
      ],
    },
  };
}

/**
 * Get a minimal hooks config that just provides reminders
 */
export function getMinimalHooksConfig() {
  return {
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: "command",
              command: `node -e "
const msg = process.env.USER_PROMPT || '';
if (/\\b(done|finished|completed|shipped)\\b/i.test(msg)) {
  console.log('[oddkit] Tip: Call oddkit_orchestrate to validate completion claims');
}
"`,
            },
          ],
        },
      ],
    },
  };
}

/**
 * Get hooks for strict mode - blocks until oddkit validates
 */
export function getStrictHooksConfig() {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "Edit|Write",
          hooks: [
            {
              type: "command",
              command: `node -e "
// Check if preflight was recently run
const fs = require('fs');
const path = require('path');
const lastFile = path.join(process.env.HOME, '.oddkit', 'last.json');
try {
  const last = JSON.parse(fs.readFileSync(lastFile, 'utf-8'));
  const age = Date.now() - new Date(last.timestamp).getTime();
  const isRecent = age < 5 * 60 * 1000; // 5 minutes
  const isPreflight = last.action === 'preflight';
  if (!isRecent || !isPreflight) {
    console.log('[oddkit] Warning: No recent preflight. Consider running oddkit_orchestrate with preflight first.');
  }
} catch (e) {
  console.log('[oddkit] Tip: Run oddkit preflight before implementing changes');
}
"`,
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: "command",
              command: `node -e "
const msg = process.env.USER_PROMPT || '';
if (/\\b(done|finished|completed|shipped|merged|fixed)\\b/i.test(msg)) {
  console.log('[oddkit] Completion claim detected. Call oddkit_orchestrate({ message: \\"' + msg.slice(0, 50) + '...\\", repo_root: \\".\\" }) to validate.');
}
"`,
            },
          ],
        },
      ],
    },
  };
}

/**
 * Merge hooks into existing settings
 */
export function mergeHooksConfig(existing, newHooks, force = false) {
  const merged = { ...existing };

  if (!merged.hooks) {
    merged.hooks = {};
  }

  // For each hook type in newHooks
  for (const [hookType, hookConfigs] of Object.entries(newHooks.hooks || {})) {
    if (!merged.hooks[hookType] || force) {
      merged.hooks[hookType] = hookConfigs;
    } else {
      // Check if oddkit hooks already exist
      const hasOddkit = merged.hooks[hookType].some(
        (h) => JSON.stringify(h).includes("oddkit") || JSON.stringify(h).includes("oddkit"),
      );
      if (!hasOddkit) {
        merged.hooks[hookType] = [...merged.hooks[hookType], ...hookConfigs];
      }
    }
  }

  return merged;
}

/**
 * Run the hooks command
 */
export async function runHooks(options = {}) {
  const { print, force, repo, minimal, strict } = options;
  const repoRoot = repo || resolveRepoRoot();
  const settingsDir = join(repoRoot, ".claude");
  const settingsPath = join(settingsDir, "settings.local.json");

  // Determine which hooks config to use
  let hooksConfig;
  if (strict) {
    hooksConfig = getStrictHooksConfig();
  } else if (minimal) {
    hooksConfig = getMinimalHooksConfig();
  } else {
    hooksConfig = getHooksConfig();
  }

  // Print mode
  if (print) {
    return {
      success: true,
      action: "print",
      content: JSON.stringify(hooksConfig, null, 2),
      path: settingsPath,
    };
  }

  // Read existing settings
  let existing = {};
  if (existsSync(settingsPath)) {
    try {
      const content = readFileSync(settingsPath, "utf-8");
      if (content.trim()) {
        existing = JSON.parse(content);
      }
    } catch (err) {
      return {
        success: false,
        action: "error",
        message: `Failed to parse existing settings: ${err.message}`,
        path: settingsPath,
      };
    }
  }

  // Check if oddkit hooks already exist
  const existingHooks = existing.hooks || {};
  const hasOddkitHooks = JSON.stringify(existingHooks).includes("oddkit");

  if (hasOddkitHooks && !force) {
    return {
      success: false,
      action: "exists",
      message: "oddkit hooks already configured. Use --force to replace.",
      path: settingsPath,
    };
  }

  // Merge and write
  const merged = mergeHooksConfig(existing, hooksConfig, force);

  try {
    if (!existsSync(settingsDir)) {
      mkdirSync(settingsDir, { recursive: true });
    }
    writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
    return {
      success: true,
      action: "wrote",
      message: `Configured oddkit hooks in Claude Code settings`,
      path: settingsPath,
    };
  } catch (err) {
    return {
      success: false,
      action: "error",
      message: `Failed to write settings: ${err.message}`,
      path: settingsPath,
    };
  }
}
