# oddkit MCP Integration

oddkit exposes an MCP (Model Context Protocol) server that allows Cursor, Claude Code, and other MCP-compatible hosts to use oddkit as a tool.

## Cursor config (long-term, run from anywhere)

Use this config to run oddkit as an MCP server via **npx from GitHub** (no npm publish required):

```json
{
  "mcpServers": {
    "oddkit": {
      "command": "npx",
      "args": ["--yes", "--package", "github:klappy/oddkit", "oddkit-mcp"],
      "env": {
        "ODDKIT_BASELINE": "https://github.com/klappy/klappy.dev.git"
      }
    }
  }
}
```

- **ODDKIT_BASELINE** is optional; default is klappy.dev.
- **repo_root** should be passed by the agent per tool call; if omitted, oddkit assumes the current working directory.

## Quick Setup with `oddkit init`

The easiest way to set up oddkit MCP:

```bash
# Global Cursor config (recommended)
npx oddkit init

# Project-local config
npx oddkit init --project

# Just print the JSON snippet (no file write)
npx oddkit init --print
```

This writes config to `~/.cursor/mcp.json` (or `<repo>/.cursor/mcp.json` for `--project`). The `init` command safely merges with existing config—it won't overwrite other MCP servers.

## Available Tools

**By default, only `oddkit_orchestrate` is exposed.** This reduces tool-choice burden and ensures Cursor uses the complete answer format.

To expose all tools for debugging, set `ODDKIT_DEV_TOOLS=1` in your MCP server environment.

| Tool                 | Description                                                                         |
| -------------------- | ----------------------------------------------------------------------------------- |
| `oddkit_orchestrate` | **Recommended.** Smart router that auto-detects intent and returns ready-to-send `assistant_text` |
| `oddkit_librarian`   | Ask a policy/lookup question against ODD-governed documentation (dev only)         |
| `oddkit_validate`    | Validate a completion claim with verdict and gaps (dev only)                        |
| `oddkit_explain`     | Explain the last oddkit result (dev only)                                           |

## Recommended: Use `oddkit_orchestrate`

For all use cases, call `oddkit_orchestrate` with the user message. It will automatically route to:

- **librarian** — for questions ("What is the definition of done?")
- **validate** — for completion claims ("Done with feature X")
- **explain** — for explain requests ("explain last")

**Key feature:** `oddkit_orchestrate` returns `assistant_text` — a complete, cited answer ready to paste. Cursor should print this verbatim without adding extra narration.

Example:

```json
{
  "name": "oddkit_orchestrate",
  "arguments": {
    "message": "What is epistemic challenge?",
    "repo_root": "/path/to/repo"
  }
}
```

Response:

```json
{
  "action": "librarian",
  "assistant_text": "Found 2 relevant document(s) for: \"What is epistemic challenge?\"\n\n> The epistemic challenge refers to the fundamental difficulty of knowing what we know and verifying claims in complex systems. When working with distributed systems, multiple stakeholders, and evolving requirements, it becomes increasingly difficult to maintain certainty about the current state of knowledge.\n\n— canon/epistemic-challenge.md#Core Problem\n\n> The primary mitigation strategy involves creating explicit documentation that captures decisions, constraints, and evidence.\n\n— canon/epistemic-challenge.md#Mitigation Strategies",
  "result": {
    "status": "SUPPORTED",
    "confidence": 0.85,
    "evidence": [...]
  }
}
```

**Cursor usage:** After calling `oddkit_orchestrate`, extract and print the `assistant_text` field verbatim. No need to add "I'm going to read..." or other narration — the answer is already complete with quotes and citations.

## Manual Setup (without init)

### For Cursor

**macOS/Linux:** `~/.cursor/mcp.json`
**Windows:** `%USERPROFILE%\.cursor\mcp.json`

Use the [Cursor config (long-term)](#cursor-config-long-term-run-from-anywhere) above, or for a local install:

```json
{
  "mcpServers": {
    "oddkit": {
      "command": "npx",
      "args": ["oddkit-mcp"],
      "env": {}
    }
  }
}
```

### For Claude Code

```json
{
  "mcpServers": {
    "oddkit": {
      "command": "npx",
      "args": ["oddkit-mcp"]
    }
  }
}
```

### From local clone

```json
{
  "mcpServers": {
    "oddkit": {
      "command": "node",
      "args": ["/path/to/oddkit/src/mcp/server.js"],
      "env": {}
    }
  }
}
```

## Tool Usage Examples

### oddkit_librarian

Ask a policy question:

```json
{
  "name": "oddkit_librarian",
  "arguments": {
    "query": "What is the definition of done?",
    "repoRoot": "/path/to/repo"
  }
}
```

Response:

```json
{
  "tool": "librarian",
  "schema_version": "1.0",
  "ok": true,
  "result": {
    "status": "SUPPORTED",
    "answer": "Found 3 relevant document(s)...",
    "evidence": [
      {
        "quote": "A task is done when...",
        "citation": "canon/definition-of-done.md#DoD",
        "origin": "baseline"
      }
    ],
    "read_next": [{ "path": "canon/definition-of-done.md", "reason": "Primary source" }]
  }
}
```

### oddkit_validate

Validate a completion claim:

```json
{
  "name": "oddkit_validate",
  "arguments": {
    "message": "Done with the UI update. Screenshot: ui.png",
    "repoRoot": "/path/to/repo"
  }
}
```

Response:

```json
{
  "tool": "validate",
  "schema_version": "1.0",
  "ok": true,
  "result": {
    "verdict": "NEEDS_ARTIFACTS",
    "claims": ["Done with the UI update"],
    "required_evidence": ["screenshot", "recording", "visual artifact"],
    "provided_artifacts": ["ui.png"],
    "gaps": ["recording"]
  }
}
```

### oddkit_explain

Explain the last result:

```json
{
  "name": "oddkit_explain",
  "arguments": {}
}
```

## CLI Tool Mode

For direct CLI usage with tool-grade output, use the `tool` subcommand:

```bash
# Always outputs tooljson envelope
oddkit tool librarian -q "What is epistemic hygiene?"
oddkit tool validate -m "Done with the feature"
oddkit tool explain
```

Or use `--format tooljson` with standard commands:

```bash
oddkit librarian -q "What is done?" --format tooljson --quiet
```

## stdin Support

To avoid shell quoting issues, oddkit supports reading from stdin:

```bash
echo "What is the definition of done?" | oddkit tool librarian -q @stdin
echo "Done with the UI update" | oddkit tool validate -m @stdin
```

## Environment Variables

| Variable              | Description                              |
| --------------------- | ---------------------------------------- |
| `ODDKIT_BASELINE`     | Override baseline repo (path or git URL) |
| `ODDKIT_BASELINE_REF` | Pin baseline to specific branch/tag      |
| `ODDKIT_DEV_TOOLS`    | Set to `1` to expose all tools (default: only `oddkit_orchestrate`) |

## Output Contract

### tooljson Format

All tools return a consistent envelope:

```json
{
  "tool": "librarian",
  "schema_version": "1.0",
  "ok": true,
  "result": { ... }
}
```

On error:

```json
{
  "tool": "librarian",
  "schema_version": "1.0",
  "ok": false,
  "error": {
    "message": "Error description",
    "code": "ERROR_CODE"
  }
}
```

### Exit Codes (CLI)

| Code | Meaning                                      |
| ---- | -------------------------------------------- |
| 0    | Success (even if verdict is NEEDS_ARTIFACTS) |
| 2    | Invalid arguments                            |
| 3    | Runtime error                                |

Note: In `tooljson` mode, errors are returned in the JSON envelope with exit code 0, since the tool executed successfully even if the operation failed.

## Troubleshooting

### MCP server not starting

1. Ensure oddkit is installed: `npm install -g oddkit` or use `npx`
2. Check Node.js version: requires Node 18+
3. Verify MCP config path and JSON syntax

### Tool not found

1. Restart Cursor/Claude Code after config changes
2. Check MCP server logs in host's output panel
3. Verify the server binary is executable

### Baseline fetch failing

1. Check network connectivity to GitHub
2. Set `ODDKIT_BASELINE` to a local path for offline use
3. Check `~/.oddkit/cache/` for cached baseline
