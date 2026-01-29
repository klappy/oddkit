# oddkit MCP Integration

oddkit exposes an MCP (Model Context Protocol) server that allows Cursor, Claude Code, and other MCP-compatible hosts to use oddkit as a tool.

## Available Tools

| Tool | Description |
|------|-------------|
| `oddkit_librarian` | Ask a policy/lookup question against ODD-governed documentation |
| `oddkit_validate` | Validate a completion claim with verdict and gaps |
| `oddkit_explain` | Explain the last oddkit result |

## Setup for Cursor

### Option 1: Add to MCP settings (recommended)

Add to your Cursor MCP configuration:

**macOS/Linux:** `~/.cursor/mcp.json`
**Windows:** `%USERPROFILE%\.cursor\mcp.json`

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

Or if you have oddkit installed globally:

```json
{
  "mcpServers": {
    "oddkit": {
      "command": "oddkit-mcp",
      "env": {}
    }
  }
}
```

### Option 2: From local clone

If you've cloned oddkit locally:

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

## Setup for Claude Code

Add to your Claude Code MCP configuration:

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
    "read_next": [
      { "path": "canon/definition-of-done.md", "reason": "Primary source" }
    ]
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

| Variable | Description |
|----------|-------------|
| `ODDKIT_BASELINE` | Override baseline repo (path or git URL) |
| `ODDKIT_BASELINE_REF` | Pin baseline to specific branch/tag |

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

| Code | Meaning |
|------|---------|
| 0 | Success (even if verdict is NEEDS_ARTIFACTS) |
| 2 | Invalid arguments |
| 3 | Runtime error |

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
