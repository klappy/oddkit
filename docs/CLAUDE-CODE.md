# oddkit + Claude Code Integration

Get oddkit working with Claude Code in under a minute.

## Quick Setup

### Option 1: One Command (Recommended)

```bash
npx oddkit init --claude
```

This configures `~/.claude.json` with the oddkit MCP server.

### Option 2: Configure All Targets

```bash
npx oddkit init --all
```

This configures both Cursor (`~/.cursor/mcp.json`) and Claude Code (`~/.claude.json`).

### Option 3: Project-Local Config

```bash
npx oddkit init --claude --project
```

This creates `.mcp.json` in your repository for project-specific configuration.

### Option 4: Claude.ai Mobile/Web (Remote MCP)

For Claude.ai on iOS, iPad, or web browsers, deploy oddkit as a Cloudflare Worker:

```bash
cd workers
npm install
npm run deploy
```

Then add the remote MCP server in Claude.ai:
1. Go to Settings → Integrations → MCP
2. Add server URL: `https://oddkit-mcp.<your-subdomain>.workers.dev/mcp`

See [workers/README.md](../workers/README.md) for full deployment instructions.

## Verify Setup

After init, restart Claude Code. You should see `oddkit_orchestrate` available as a tool.

Test it by asking Claude Code:
- "What's in ODD?"
- "preflight: implement a new feature"

## Generate CLAUDE.md

To add project-level context for Claude Code:

```bash
npx oddkit claudemd
```

This creates a `CLAUDE.md` file with oddkit integration instructions that Claude Code will automatically read.

Options:
- `--print` — Print to stdout only
- `--force` — Overwrite existing CLAUDE.md
- `--advanced` — Include advanced epistemic mode documentation

## Configure Hooks (Optional)

Claude Code supports hooks that can integrate with oddkit:

```bash
npx oddkit hooks
```

This creates `.claude/settings.local.json` with hooks that:
- Remind you to run preflight before implementing
- Detect completion claims and suggest validation

Hook modes:
- `--minimal` — Just completion detection
- `--strict` — Validation reminders before file edits

## How It Works

### The oddkit_orchestrate Tool

Claude Code gets access to `oddkit_orchestrate`, a smart router that:

1. **Preflight** — Before implementing, get guidance on what to read
2. **Librarian** — Answer policy questions with citations
3. **Validate** — Check if completion claims have required evidence
4. **Catalog** — Discover available ODD documentation

### Usage Pattern

```
User: "Implement user authentication"
Claude: [calls oddkit_orchestrate with "preflight: implement user authentication"]
Claude: [reads suggested files, notes constraints]
Claude: [implements the feature]
Claude: [calls oddkit_orchestrate with "done: implemented auth. Screenshot: auth.png"]
Claude: [if VERIFIED, reports completion; if NEEDS_ARTIFACTS, provides missing evidence]
```

### Response Format

oddkit returns JSON with an `assistant_text` field containing a complete, cited answer:

```json
{
  "action": "librarian",
  "assistant_text": "Found relevant documentation...\n\n> Quote from canon...\n\n— canon/definition-of-done.md#DoD",
  "result": { ... }
}
```

Claude Code should use `assistant_text` directly — it's ready for verbatim output.

## Spawned Agents

When Claude Code spawns subagents (via Task tool), they inherit MCP server access. Subagents should:

1. Read `oddkit://quickstart` resource for usage patterns
2. Always pass `repo_root: "."` when calling tools
3. Follow the same preflight → implement → validate pattern

## Troubleshooting

### Tool not appearing

1. Restart Claude Code after running `oddkit init --claude`
2. Check `~/.claude.json` exists and contains oddkit config
3. Try `npx oddkit init --claude --force` to refresh config

### Preflight not returning results

1. Ensure you're in a git repository
2. Check baseline is accessible: `npx oddkit librarian -q "test" -r .`

### MCP server errors

1. Ensure Node.js 18+ is installed
2. Check npm/npx are working: `npx --version`
3. Try verbose mode: `ODDKIT_DEBUG_MCP=1 npx oddkit-mcp`

## Full Configuration Reference

### MCP Config Location

| Target | Global Path | Project Path |
|--------|-------------|--------------|
| Claude Code | `~/.claude.json` | `.mcp.json` |
| Cursor | `~/.cursor/mcp.json` | `.cursor/mcp.json` |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ODDKIT_BASELINE` | Override baseline repo (git URL or local path) |
| `ODDKIT_BASELINE_REF` | Pin baseline to specific branch/tag |
| `ODDKIT_DEV_TOOLS` | Set to `1` to expose all tools (debugging) |
| `ODDKIT_DEBUG_MCP` | Set to `1` for verbose MCP logging |

### Manual Config

If you prefer manual configuration, add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "oddkit": {
      "command": "npx",
      "args": ["--yes", "--package", "github:klappy/oddkit", "oddkit-mcp"]
    }
  }
}
```

## Next Steps

- Read [docs/MCP.md](MCP.md) for full MCP integration details
- Read [docs/getting-started/agents.md](getting-started/agents.md) for Epistemic Guide + Scribe setup
- Visit [klappy.dev/odd](https://klappy.dev/odd) for ODD methodology documentation
