import { Command } from "commander";
import { createInterface } from "readline";
import { createRequire } from "module";
import { TOOLS } from "./core/tool-registry.js";
import { handleAction } from "./core/actions.js";
import { runIndex } from "./tasks/indexTask.js";
import { runLibrarian } from "./tasks/librarian.js";
import { runValidate } from "./tasks/validate.js";
import { explainLast } from "./explain/explain-last.js";
import { runInit } from "./cli/init.js";
import { runClaudeMd } from "./cli/claudemd.js";
import { runHooks } from "./cli/hooks.js";
import { registerSyncAgentsCommand } from "./cli/syncAgents.js";
import { runAuditEpoch } from "./audit/auditEpoch.js";

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require("../package.json");

const SCHEMA_VERSION = "1.0";

// Exit codes (tool-grade contract)
const EXIT_OK = 0;
const EXIT_BAD_ARGS = 2;
const EXIT_RUNTIME_ERROR = 3;

/**
 * Read input from stdin (for @stdin support)
 */
async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });
    rl.on("line", (line) => {
      data += line + "\n";
    });
    rl.on("close", () => {
      resolve(data.trim());
    });
    rl.on("error", reject);
  });
}

/**
 * Resolve input value - if @stdin, read from stdin
 */
async function resolveInput(value) {
  if (value === "@stdin") {
    return readStdin();
  }
  return value;
}

/**
 * Wrap result in tooljson envelope
 */
function wrapToolJson(tool, result, ok = true) {
  return {
    tool,
    schema_version: SCHEMA_VERSION,
    ok,
    result,
  };
}

/**
 * Wrap error in tooljson envelope
 */
function wrapToolJsonError(tool, error) {
  return {
    tool,
    schema_version: SCHEMA_VERSION,
    ok: false,
    error: {
      message: error.message || String(error),
      code: error.code || "RUNTIME_ERROR",
    },
  };
}

/**
 * Check whether a handleAction result represents an error.
 * handleAction catches internally and returns error envelopes, so callers
 * must inspect the result rather than relying on exceptions.
 */
function isActionError(actionResult) {
  return actionResult.action === "error" || !!actionResult.result?.error;
}

/**
 * Output handleAction result based on format
 */
function outputActionResult(actionName, actionResult, format, quiet) {
  if (format === "tooljson") {
    const ok = !isActionError(actionResult);
    console.log(JSON.stringify(wrapToolJson(actionName, actionResult, ok)));
  } else if (format === "json") {
    console.log(JSON.stringify(actionResult, null, 2));
  } else if (format === "md") {
    // For md format, prefer assistant_text if available
    if (actionResult.assistant_text) {
      console.log(actionResult.assistant_text);
    } else {
      console.log(JSON.stringify(actionResult, null, 2));
    }
  } else {
    console.log(JSON.stringify(actionResult, null, 2));
  }
}

/**
 * Output legacy task result based on format (for backward-compat commands)
 */
function outputResult(tool, result, format, quiet) {
  if (format === "tooljson") {
    console.log(JSON.stringify(wrapToolJson(tool, result)));
  } else if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else if (format === "md") {
    if (tool === "librarian") {
      console.log(renderLibrarianMarkdown(result));
    } else if (tool === "validate") {
      console.log(renderValidateMarkdown(result));
    } else if (tool === "explain") {
      console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

/**
 * Output error based on format
 */
function outputError(tool, error, format, quiet) {
  if (format === "tooljson") {
    console.log(JSON.stringify(wrapToolJsonError(tool, error)));
  } else {
    if (!quiet) {
      console.error(`${tool} error:`, error.message);
    }
  }
}

/**
 * Main CLI entry point
 */
export function run() {
  const program = new Command();

  program
    .name("oddkit")
    .description("Agent-first CLI for ODD-governed repos")
    .version(PKG_VERSION)
    // Global options
    .option("--quiet", "Suppress non-essential output (logs, banners)")
    .option("--no-color", "Disable colored output");

  // ────────────────────────────────────────────────────────────────────────────
  // Epistemic tools — all 11 actions from shared registry
  // ────────────────────────────────────────────────────────────────────────────

  for (const tool of TOOLS) {
    const cmd = program
      .command(tool.name)
      .description(tool.description);

    // Register flags from shared schema
    for (const [key, def] of Object.entries(tool.cliFlags || {})) {
      cmd.option(def.flag, def.description);
    }

    // Backward-compat aliases for legacy flag names
    if (tool.name === "validate") {
      cmd.option("-m, --message <text>", "The completion claim (alias for --input)");
    }
    if (tool.name === "search") {
      cmd.option("-q, --query <text>", "The question to ask (alias for --input)");
    }

    // Global flags all epistemic commands share
    cmd.option("-r, --repo <path>", "Repository root path", process.cwd());
    cmd.option("-f, --format <type>", "Output format: json, md, or tooljson", "json");
    cmd.option("-b, --baseline <path-or-url>", "Override baseline repo (path or git URL)");

    cmd.action(async (options, cmdObj) => {
      const globalOpts = cmdObj.optsWithGlobals();
      const format = options.format;
      const quiet = globalOpts.quiet;

      try {
        // Resolve input (support @stdin and legacy flag aliases)
        let input = options.input || options.message || options.query;
        if (input) {
          input = await resolveInput(input);
        }

        // Check required input
        const inputRequired = tool.inputSchema.required?.includes("input");
        if (inputRequired && !input) {
          const err = new Error("Missing required option: --input");
          err.code = "BAD_ARGS";
          outputError(tool.name, err, format, quiet);
          process.exit(format === "tooljson" ? EXIT_OK : EXIT_BAD_ARGS);
          return;
        }

        const result = await handleAction({
          action: tool.name,
          input: input || "",
          context: options.context,
          mode: options.mode,
          baseline: options.baseline,
          repoRoot: options.repo,
          files: options.files ? JSON.parse(options.files) : undefined,
          message: options.commitMessage,
          branch: options.branch,
          pr: options.pr,
          surface: "cli",
        });

        outputActionResult(tool.name, result, format, quiet);

        // handleAction returns error envelopes instead of throwing,
        // so check the result to set the correct exit code.
        process.exit(isActionError(result) && format !== "tooljson" ? EXIT_RUNTIME_ERROR : EXIT_OK);
      } catch (err) {
        // Defensive: handleAction should not throw, but guard against
        // unexpected failures (e.g. import errors, OOM).
        outputError(tool.name, err, format, quiet);
        process.exit(format === "tooljson" ? EXIT_OK : EXIT_RUNTIME_ERROR);
      }
    });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Legacy: librarian command (deprecated alias for search)
  // ────────────────────────────────────────────────────────────────────────────

  program
    .command("librarian")
    .description("[deprecated — use 'search'] Ask a policy/lookup question")
    .option("-q, --query <text>", "The question to ask (use @stdin to read from stdin)")
    .option("-i, --input <text>", "The question (alias for --query)")
    .option("-r, --repo <path>", "Repository root path", process.cwd())
    .option("-b, --baseline <path-or-url>", "Override baseline repo (path or git URL)")
    .option("-f, --format <type>", "Output format: tooljson, json, or md", "json")
    .action(async (options, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const format = options.format;
      const quiet = globalOpts.quiet;

      if (!quiet) {
        console.error("Note: 'oddkit librarian' is deprecated. Use 'oddkit search' instead.");
      }

      try {
        let query = options.query || options.input;
        if (!query) {
          const err = new Error("Missing required option: --query");
          err.code = "BAD_ARGS";
          outputError("librarian", err, format, quiet);
          process.exit(format === "tooljson" ? EXIT_OK : EXIT_BAD_ARGS);
          return;
        }
        query = await resolveInput(query);

        const result = await runLibrarian({ ...options, query });
        outputResult("librarian", result, format, quiet);
        process.exit(EXIT_OK);
      } catch (err) {
        outputError("librarian", err, format, quiet);
        process.exit(format === "tooljson" ? EXIT_OK : EXIT_RUNTIME_ERROR);
      }
    });

  // ────────────────────────────────────────────────────────────────────────────
  // Setup / utility commands (CLI-only, no MCP equivalent)
  // ────────────────────────────────────────────────────────────────────────────

  // Index command
  program
    .command("index")
    .description("Build or rebuild the document index")
    .option("-r, --repo <path>", "Repository root path", process.cwd())
    .option("-b, --baseline <path-or-url>", "Override baseline repo (path or git URL)")
    .option("-f, --format <type>", "Output format: tooljson, json, or md", "json")
    .option("--force", "Force rebuild even if index exists")
    .action(async (options, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const format = options.format;
      const quiet = globalOpts.quiet;

      try {
        const result = await runIndex(options);
        outputResult("index", result, format, quiet);
        process.exit(EXIT_OK);
      } catch (err) {
        outputError("index", err, format, quiet);
        process.exit(format === "tooljson" ? EXIT_OK : EXIT_RUNTIME_ERROR);
      }
    });

  // Explain command (CLI-only convenience)
  program
    .command("explain")
    .description("Explain the last oddkit result in human-readable format")
    .option("--last", "Explain the last result (default)", true)
    .option("-f, --format <type>", "Output format: tooljson, json, or md", "md")
    .action(async (options, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const format = options.format;
      const quiet = globalOpts.quiet;

      try {
        const result = explainLast({ format: "json" });

        if (format === "tooljson") {
          outputResult("explain", result, format, quiet);
        } else if (format === "json") {
          console.log(JSON.stringify(result, null, 2));
        } else {
          const mdResult = explainLast({ format: "md" });
          console.log(mdResult);
        }
        process.exit(EXIT_OK);
      } catch (err) {
        outputError("explain", err, format, quiet);
        process.exit(format === "tooljson" ? EXIT_OK : EXIT_RUNTIME_ERROR);
      }
    });

  // Init command - setup MCP configuration
  program
    .command("init")
    .description("Set up MCP configuration for Cursor or Claude Code")
    .option("--project", "Write to project-local config")
    .option("--cursor", "Write to Cursor config (~/.cursor/mcp.json)")
    .option("--claude", "Write to Claude Code config (~/.claude.json)")
    .option("--all", "Configure all supported MCP targets (Cursor + Claude Code)")
    .option("--print", "Print JSON snippet only (no file writes)")
    .option("--force", "Replace existing oddkit entry if different")
    .option("-r, --repo <path>", "Repository root path (for --project)")
    .action(async (options, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const quiet = globalOpts.quiet;

      try {
        const result = await runInit(options);

        if (options.print) {
          console.log(JSON.stringify(result.snippet, null, 2));
          process.exit(EXIT_OK);
          return;
        }

        if (result.action === "all") {
          let hasErrors = false;
          for (const r of result.results) {
            if (!quiet) {
              if (r.action === "wrote") {
                console.log(`Wrote ${r.targetName} config: ${r.targetPath}`);
              } else if (r.action === "unchanged") {
                console.log(`${r.targetName}: ${r.message}`);
              } else if (r.action === "conflict") {
                console.error(`${r.targetName}: ${r.message}`);
                hasErrors = true;
              } else if (r.action === "error") {
                console.error(`${r.targetName} error: ${r.error || r.message}`);
                hasErrors = true;
              }
            }
          }
          process.exit(hasErrors ? EXIT_RUNTIME_ERROR : EXIT_OK);
          return;
        }

        if (!result.success) {
          if (result.action === "conflict") {
            if (!quiet) {
              console.error(result.message);
            }
            process.exit(EXIT_BAD_ARGS);
          } else {
            if (!quiet) {
              console.error("Init error:", result.error || result.message);
            }
            process.exit(EXIT_RUNTIME_ERROR);
          }
          return;
        }

        if (!quiet) {
          if (result.action === "wrote") {
            console.log(`Wrote ${result.targetName} config: ${result.targetPath}`);
          } else if (result.action === "unchanged") {
            console.log(result.message);
          }
        }
        process.exit(EXIT_OK);
      } catch (err) {
        if (!quiet) {
          console.error("Init error:", err.message);
        }
        process.exit(EXIT_RUNTIME_ERROR);
      }
    });

  // CLAUDE.md generator command
  program
    .command("claudemd")
    .description("Generate CLAUDE.md with oddkit integration instructions")
    .option("--print", "Print to stdout only (no file write)")
    .option("--force", "Overwrite existing CLAUDE.md")
    .option("--advanced", "Include advanced epistemic mode documentation")
    .option("-r, --repo <path>", "Repository root path", process.cwd())
    .action(async (options, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const quiet = globalOpts.quiet;

      try {
        const result = await runClaudeMd(options);

        if (options.print) {
          console.log(result.content);
          process.exit(EXIT_OK);
          return;
        }

        if (!result.success) {
          if (!quiet) {
            console.error(result.message);
          }
          process.exit(result.action === "exists" ? EXIT_BAD_ARGS : EXIT_RUNTIME_ERROR);
          return;
        }

        if (!quiet) {
          console.log(result.message);
          console.log(`Path: ${result.path}`);
        }
        process.exit(EXIT_OK);
      } catch (err) {
        if (!quiet) {
          console.error("claudemd error:", err.message);
        }
        process.exit(EXIT_RUNTIME_ERROR);
      }
    });

  // Hooks command - generate Claude Code hooks
  program
    .command("hooks")
    .description("Generate Claude Code hooks for automatic oddkit integration")
    .option("--print", "Print hooks config to stdout only")
    .option("--force", "Overwrite existing oddkit hooks")
    .option("--minimal", "Use minimal hooks (just completion detection)")
    .option("--strict", "Use strict hooks (validation reminders)")
    .option("-r, --repo <path>", "Repository root path", process.cwd())
    .action(async (options, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const quiet = globalOpts.quiet;

      try {
        const result = await runHooks(options);

        if (options.print) {
          console.log(result.content);
          process.exit(EXIT_OK);
          return;
        }

        if (!result.success) {
          if (!quiet) {
            console.error(result.message);
          }
          process.exit(result.action === "exists" ? EXIT_BAD_ARGS : EXIT_RUNTIME_ERROR);
          return;
        }

        if (!quiet) {
          console.log(result.message);
          console.log(`Path: ${result.path}`);
        }
        process.exit(EXIT_OK);
      } catch (err) {
        if (!quiet) {
          console.error("hooks error:", err.message);
        }
        process.exit(EXIT_RUNTIME_ERROR);
      }
    });

  // ────────────────────────────────────────────────────────────────────────────
  // Tool subcommand group — tooljson envelope output via shared registry
  // ────────────────────────────────────────────────────────────────────────────

  const toolCmd = program
    .command("tool")
    .description("Tool-mode commands (always output tooljson envelope)");

  // Register all 11 epistemic tools under `oddkit tool <name>`
  for (const tool of TOOLS) {
    const sub = toolCmd
      .command(tool.name)
      .description(`${tool.description} (tooljson output)`);

    for (const [key, def] of Object.entries(tool.cliFlags || {})) {
      sub.option(def.flag, def.description);
    }

    // Backward-compat aliases for legacy flag names
    if (tool.name === "validate") {
      sub.option("-m, --message <text>", "The completion claim (alias for --input)");
    }
    if (tool.name === "search") {
      sub.option("-q, --query <text>", "The question to ask (alias for --input)");
    }

    sub.option("-r, --repo <path>", "Repository root path", process.cwd());
    sub.option("-b, --baseline <path-or-url>", "Override baseline repo (path or git URL)");

    sub.action(async (options) => {
      try {
        let input = options.input || options.message || options.query;
        if (input) {
          input = await resolveInput(input);
        }

        const inputRequired = tool.inputSchema.required?.includes("input");
        if (inputRequired && !input) {
          const err = new Error(`Missing required option: --input`);
          err.code = "BAD_ARGS";
          console.log(JSON.stringify(wrapToolJsonError(tool.name, err)));
          process.exit(EXIT_OK);
          return;
        }

        const result = await handleAction({
          action: tool.name,
          input: input || "",
          context: options.context,
          mode: options.mode,
          baseline: options.baseline,
          repoRoot: options.repo,
          files: options.files ? JSON.parse(options.files) : undefined,
          message: options.commitMessage,
          branch: options.branch,
          pr: options.pr,
          surface: "cli",
        });
        const ok = !isActionError(result);
        console.log(JSON.stringify(wrapToolJson(tool.name, result, ok)));
        process.exit(EXIT_OK);
      } catch (err) {
        // Defensive: handleAction should not throw, but guard against
        // unexpected failures (e.g. import errors, OOM).
        console.log(JSON.stringify(wrapToolJsonError(tool.name, err)));
        process.exit(EXIT_OK);
      }
    });
  }

  // Legacy: tool librarian (deprecated alias for tool search)
  toolCmd
    .command("librarian")
    .description("[deprecated — use 'tool search'] Ask a policy/lookup question (tooljson output)")
    .option("-q, --query <text>", "The question to ask (use @stdin to read from stdin)")
    .option("-r, --repo <path>", "Repository root path", process.cwd())
    .option("-b, --baseline <path-or-url>", "Override baseline repo (path or git URL)")
    .action(async (options) => {
      try {
        let query = options.query;
        if (!query) {
          const err = new Error("Missing required option: --query");
          err.code = "BAD_ARGS";
          console.log(JSON.stringify(wrapToolJsonError("librarian", err)));
          process.exit(EXIT_OK);
          return;
        }
        query = await resolveInput(query);

        const result = await runLibrarian({ ...options, query, format: "json" });
        console.log(JSON.stringify(wrapToolJson("librarian", result)));
        process.exit(EXIT_OK);
      } catch (err) {
        console.log(JSON.stringify(wrapToolJsonError("librarian", err)));
        process.exit(EXIT_OK);
      }
    });

  // Legacy: tool validate (deprecated alias for tool validate via handleAction)
  toolCmd
    .command("validate-legacy")
    .description("[deprecated — use 'tool validate'] Validate completion claim (tooljson output)")
    .option("-m, --message <text>", "The completion claim message (use @stdin to read from stdin)")
    .option("-r, --repo <path>", "Repository root path", process.cwd())
    .option("-b, --baseline <path-or-url>", "Override baseline repo (path or git URL)")
    .option("-a, --artifacts <path>", "Path to artifacts JSON file")
    .action(async (options) => {
      try {
        let message = options.message;
        if (!message) {
          const err = new Error("Missing required option: --message");
          err.code = "BAD_ARGS";
          console.log(JSON.stringify(wrapToolJsonError("validate", err)));
          process.exit(EXIT_OK);
          return;
        }
        message = await resolveInput(message);

        const result = await runValidate({ ...options, message, format: "json" });
        console.log(JSON.stringify(wrapToolJson("validate", result)));
        process.exit(EXIT_OK);
      } catch (err) {
        console.log(JSON.stringify(wrapToolJsonError("validate", err)));
        process.exit(EXIT_OK);
      }
    });

  // tool explain (CLI-only convenience, kept as-is)
  toolCmd
    .command("explain")
    .description("Explain the last oddkit result (tooljson output)")
    .action(async () => {
      try {
        const result = explainLast({ format: "json" });
        console.log(JSON.stringify(wrapToolJson("explain", result)));
        process.exit(EXIT_OK);
      } catch (err) {
        console.log(JSON.stringify(wrapToolJsonError("explain", err)));
        process.exit(EXIT_OK);
      }
    });

  // Register sync-agents command
  registerSyncAgentsCommand(program);

  // Audit subcommand group
  const auditCmd = program
    .command("audit")
    .description("Audit commands for epoch compatibility verification");

  auditCmd
    .command("epoch")
    .description("Run full epoch compatibility audit against baseline")
    .option("-b, --baseline <url>", "Baseline repo URL", "https://github.com/klappy/klappy.dev.git")
    .option("--ref <ref>", "Baseline ref (branch or tag)", "main")
    .option("--fresh", "Purge cache and pull fresh baseline")
    .option("--ci", "CI mode (less verbose, exit code based on verdict)")
    .option("-r, --repo <path>", "Repository root path", process.cwd())
    .option("-f, --format <type>", "Output format: json or summary", "summary")
    .action(async (options, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const quiet = globalOpts.quiet;

      try {
        const result = await runAuditEpoch({
          baseline: options.baseline,
          ref: options.ref,
          fresh: options.fresh || false,
          ci: options.ci || false,
          verbose: !options.ci && !quiet,
          repoRoot: options.repo,
        });

        if (options.format === "json") {
          console.log(JSON.stringify(result.json, null, 2));
        } else {
          console.log(`Verdict: ${result.verdict}`);
          console.log(`Tests: ${result.tests.passed}/${result.tests.total} passed`);
          console.log(`Probes: ${result.probes.passed}/${result.probes.total} passed`);
          console.log(`Baseline: ${result.baseline.commit}`);
          console.log(`Receipt: ${result.receipts.latest_md}`);

          if (result.json.warnings && result.json.warnings.length > 0) {
            for (const w of result.json.warnings) {
              console.log(`WARNING_${w}=true`);
            }
          }
        }

        process.exit(result.compatible ? EXIT_OK : EXIT_RUNTIME_ERROR);
      } catch (err) {
        if (!quiet) {
          console.error("Audit error:", err.message);
        }
        process.exit(EXIT_RUNTIME_ERROR);
      }
    });

  program.parse();
}

function renderLibrarianMarkdown(result) {
  const lines = [];
  lines.push(`### Status`);
  lines.push(result.status);
  lines.push("");
  lines.push(`### Answer`);
  lines.push(result.answer);
  lines.push("");
  lines.push(`### Evidence`);
  for (const e of result.evidence) {
    lines.push(`- "${e.quote}" — \`${e.citation}\` (${e.origin})`);
  }
  if (result.read_next && result.read_next.length > 0) {
    lines.push("");
    lines.push(`### Read Next`);
    for (const r of result.read_next) {
      lines.push(`- \`${r.path}\` — ${r.reason}`);
    }
  }
  return lines.join("\n");
}

function renderValidateMarkdown(result) {
  const lines = [];
  lines.push(`### Verdict`);
  lines.push(result.verdict);
  lines.push("");
  lines.push(`### Claims`);
  for (const c of result.claims) {
    lines.push(`- ${c}`);
  }
  lines.push("");
  lines.push(`### Required Evidence`);
  for (const r of result.required_evidence) {
    lines.push(`- ${r}`);
  }
  lines.push("");
  lines.push(`### Provided Artifacts`);
  for (const p of result.provided_artifacts) {
    lines.push(`- ${p}`);
  }
  if (result.gaps.length > 0) {
    lines.push("");
    lines.push(`### Gaps`);
    for (const g of result.gaps) {
      lines.push(`- ${g}`);
    }
  }
  return lines.join("\n");
}
