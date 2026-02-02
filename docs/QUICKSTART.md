# oddkit Quickstart

Get running in 60 seconds.

## What's in the Box

oddkit has three layers:

| Layer      | What It Is                                                | Setup                       |
| ---------- | --------------------------------------------------------- | --------------------------- |
| **CLI**    | Command-line tools (`oddkit librarian`, `validate`, etc.) | `npx oddkit <command>`      |
| **MCP**    | Model Context Protocol server for IDE integration         | `npx oddkit init`           |
| **Agents** | Subagent prompts (Epistemic Guide, Scribe)                | Copy to `~/.cursor/agents/` |

**New to ODD?** Start with [ODD Agents](getting-started/agents.md) to understand the system.

---

## Quick Links

- [Claude Code Guide](CLAUDE-CODE.md) — Claude Code specific setup
- [Agents Guide](getting-started/agents.md) — Set up Epistemic Guide + Scribe
- [Ledger Guide](getting-started/ledger.md) — Capture learnings and decisions
- [MCP.md](MCP.md) — Full MCP integration details
- [klappy.dev/odd](https://klappy.dev/odd) — ODD methodology docs

---

## Claude Code Setup (Recommended)

```bash
npx oddkit init --claude
# Restart Claude Code
```

This writes MCP config to `~/.claude.json`. See [CLAUDE-CODE.md](CLAUDE-CODE.md) for full details.

**Configure both Cursor and Claude Code:**

```bash
npx oddkit init --all
```

---

## Cursor Setup

To use oddkit as an MCP server in Cursor, see **[docs/MCP.md](MCP.md)**. You can run oddkit from anywhere via:

```bash
npx --yes --package github:klappy/oddkit oddkit-mcp
```

## Use in Cursor

### Option A: One command (global)

```bash
npx oddkit init --cursor
# Restart Cursor if prompted
```

This writes MCP config to `~/.cursor/mcp.json` and wires oddkit as a tool.

### Option B: Project-local config

```bash
npx oddkit init --cursor --project
```

This writes to `<repo>/.cursor/mcp.json` instead.

### Automatic Instructions

After MCP setup, oddkit provides default instructions automatically via MCP GetInstructions. No additional prompts or per-repo config files are required. The agent knows when to call `oddkit_orchestrate` at policy questions, completion claims, and PRD work.

### Verify

After init, Cursor should show the `oddkit_orchestrate` tool. You can also verify from CLI:

```bash
npx oddkit librarian -q "What is epistemic challenge?" -r .
```

### Compass Prompts (Recommended)

oddkit provides MCP prompts that teach agents when to consult oddkit — without preinjecting documentation.

1. In Cursor chat, select `oddkit_compass` (for coding) or `oddkit_compass_prd` (for PRD work)
2. Then talk normally — the agent automatically consults oddkit at decision points

See [docs/MCP.md](MCP.md#compass-prompts) for details.

### Manual Cursor Usage

When using oddkit in Cursor without prompts:

1. **Call `oddkit_orchestrate`** with the user's question or message
2. **Extract `assistant_text`** from the response
3. **Print it verbatim** — it's already a complete answer with quotes and citations

Example:

- User asks: "What is epistemic challenge?"
- Cursor calls: `oddkit_orchestrate({ message: "What is epistemic challenge?", repo_root: "." })`
- Cursor prints: the `assistant_text` field directly (no extra narration needed)

The `assistant_text` includes:

- Complete answer with 2-4 substantial quotes
- Citations (path#anchor format)
- Advisory messaging if confidence is low

**Note:** By default, only `oddkit_orchestrate` is exposed. Set `ODDKIT_DEV_TOOLS=1` in your MCP server environment to see all tools for debugging.

### Preflight (Before Implementation)

Before implementing code changes, run a preflight check:

```
oddkit_orchestrate({ message: "preflight: implement X", repo_root: "." })
```

This returns relevant files to read, constraints, DoD pointer, and pitfalls — without injecting doc content. The agent then reads what it needs and implements.

**Natural workflow:** preflight → implement → validate

See [docs/MCP.md](MCP.md#preflight-pre-implementation-consultation) for details.

### Discoverability (Catalog)

Ask for a menu of ODD docs — no preinjected content. Examples:

- "What's in ODD?"
- "List the canon"
- "What should I read next?"
- "Show me the doctrines"
- "Show me the ODD map"

These route through `oddkit_orchestrate` and return a catalog (Start here / Next up / Top canon by tag / Playbooks). See [docs/MCP.md](MCP.md#catalog--discoverability).

---

## Manual Installation

### Option A: Run via npx from GitHub (no install)

```bash
npx github:klappy/oddkit librarian -q "What is epistemic hygiene?" -r /path/to/repo
```

### Option B: Clone and run locally

```bash
git clone https://github.com/klappy/oddkit.git
cd oddkit
npm install
node bin/oddkit librarian -q "What is epistemic hygiene?" -r /path/to/repo
```

## Commands

```bash
# Build the document index
oddkit index -r /path/to/repo

# Ask a policy question
oddkit librarian -q "What is the definition of done?" -r /path/to/repo

# Validate a completion claim
oddkit validate -m "Done with the UI update. Screenshot: ui.png" -r /path/to/repo

# Explain the last result in human-readable format
oddkit explain --last
```

## Baseline Knowledge

By default, oddkit uses [klappy.dev](https://github.com/klappy/klappy.dev) as the baseline canon. This provides the standard ODD rules, epistemic modes, and definitions.

### Override the baseline

```bash
# Via environment variable
export ODDKIT_BASELINE="https://github.com/yourorg/your-canon.git"
oddkit librarian -q "What is done?"

# Via CLI flag (overrides env var)
oddkit librarian -q "What is done?" --baseline /path/to/local/canon

# Pin to a specific branch/tag
export ODDKIT_BASELINE_REF="v1.0.0"
oddkit librarian -q "What is done?"
```

### Resolution order

1. `--baseline <path-or-git-url>` CLI flag
2. `ODDKIT_BASELINE` environment variable
3. Default: `https://github.com/klappy/klappy.dev`

## Local Overrides

Your repo can override baseline docs using `supersedes` in frontmatter:

```yaml
---
supersedes: klappy://canon/definition-of-done
---
```

This suppresses the baseline doc and uses your local version instead.

## Output Formats

```bash
# JSON (default, machine-parseable)
oddkit librarian -q "What is done?" -f json

# Markdown (human-readable)
oddkit librarian -q "What is done?" -f md
```

## For Agents

oddkit is designed for AI agents to call:

```bash
# Agent asks a question, gets JSON
oddkit librarian -q "What evidence is required for UI changes?" -f json

# Agent validates completion, gets verdict
oddkit validate -m "Implemented search. Screenshot: search.png" -f json
```
