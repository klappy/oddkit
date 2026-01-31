import { Command } from "commander";
import { createInterface } from "readline";
import { runLibrarian } from "./tasks/librarian.js";
import { runValidate } from "./tasks/validate.js";
import { runIndex } from "./tasks/indexTask.js";
import { explainLast } from "./explain/explain-last.js";
import { runInit, getOddkitMcpSnippet } from "./cli/init.js";
import { registerSyncAgentsCommand } from "./cli/syncAgents.js";
import { runAuditEpoch } from "./audit/auditEpoch.js";

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
 * Output result based on format
 */
function outputResult(tool, result, format, quiet) {
  if (format === "tooljson") {
    // tooljson: strict envelope, no pretty printing for machine consumption
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
    // tooljson: error goes to stdout as JSON envelope
    console.log(JSON.stringify(wrapToolJsonError(tool, error)));
  } else {
    // Other formats: error goes to stderr
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
    .version("0.1.0")
    // Global options
    .option("--quiet", "Suppress non-essential output (logs, banners)")
    .option("--no-color", "Disable colored output");

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

  // Librarian command
  program
    .command("librarian")
    .description("Ask a policy/lookup question")
    .option("-q, --query <text>", "The question to ask (use @stdin to read from stdin)")
    .option("-r, --repo <path>", "Repository root path", process.cwd())
    .option("-b, --baseline <path-or-url>", "Override baseline repo (path or git URL)")
    .option("-f, --format <type>", "Output format: tooljson, json, or md", "json")
    .action(async (options, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const format = options.format;
      const quiet = globalOpts.quiet;

      try {
        // Resolve query (support @stdin)
        let query = options.query;
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

  // Validate command
  program
    .command("validate")
    .description("Validate a completion claim")
    .option("-m, --message <text>", "The completion claim message (use @stdin to read from stdin)")
    .option("-r, --repo <path>", "Repository root path", process.cwd())
    .option("-b, --baseline <path-or-url>", "Override baseline repo (path or git URL)")
    .option("-a, --artifacts <path>", "Path to artifacts JSON file")
    .option("-f, --format <type>", "Output format: tooljson, json, or md", "json")
    .action(async (options, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const format = options.format;
      const quiet = globalOpts.quiet;

      try {
        // Resolve message (support @stdin)
        let message = options.message;
        if (!message) {
          const err = new Error("Missing required option: --message");
          err.code = "BAD_ARGS";
          outputError("validate", err, format, quiet);
          process.exit(format === "tooljson" ? EXIT_OK : EXIT_BAD_ARGS);
          return;
        }
        message = await resolveInput(message);

        const result = await runValidate({ ...options, message });
        outputResult("validate", result, format, quiet);
        process.exit(EXIT_OK);
      } catch (err) {
        outputError("validate", err, format, quiet);
        process.exit(format === "tooljson" ? EXIT_OK : EXIT_RUNTIME_ERROR);
      }
    });

  // Explain command
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
        // For explain, get JSON result always, then format
        const result = explainLast({ format: "json" });

        if (format === "tooljson") {
          outputResult("explain", result, format, quiet);
        } else if (format === "json") {
          console.log(JSON.stringify(result, null, 2));
        } else {
          // md format - render human-readable
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
    .description("Set up MCP configuration for Cursor")
    .option("--project", "Write to project-local config (<repo>/.cursor/mcp.json)")
    .option("--cursor", "Write to global Cursor config (default)")
    .option("--print", "Print JSON snippet only (no file writes)")
    .option("--force", "Replace existing oddkit entry if different")
    .option("-r, --repo <path>", "Repository root path (for --project)")
    .action(async (options, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const quiet = globalOpts.quiet;

      try {
        const result = await runInit(options);

        if (options.print) {
          // Print mode: just output the JSON snippet
          console.log(JSON.stringify(result.snippet, null, 2));
          process.exit(EXIT_OK);
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

        // Success
        if (!quiet) {
          if (result.action === "wrote") {
            const typeLabel = result.targetType === "project" ? "project" : "Cursor";
            console.log(`Wrote ${typeLabel} MCP config: ${result.targetPath}`);
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

  // Tool subcommand group - always outputs tooljson envelope
  const toolCmd = program
    .command("tool")
    .description("Tool-mode commands (always output tooljson envelope)");

  toolCmd
    .command("librarian")
    .description("Ask a policy/lookup question (tooljson output)")
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

  toolCmd
    .command("validate")
    .description("Validate a completion claim (tooljson output)")
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
          // Summary format
          console.log(`Verdict: ${result.verdict}`);
          console.log(`Tests: ${result.tests.passed}/${result.tests.total} passed`);
          console.log(`Probes: ${result.probes.passed}/${result.probes.total} passed`);
          console.log(`Baseline: ${result.baseline.commit}`);
          console.log(`Receipt: ${result.receipts.latest_md}`);
        }

        // Exit code based on verdict
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
