# oddkit Quickstart

Get running in 60 seconds.

## Use in Cursor (recommended)

### Option A: One command (global)

```bash
npx oddkit init
# Restart Cursor if prompted
```

This writes MCP config to `~/.cursor/mcp.json` and wires oddkit as a tool.

### Option B: Project-local config

```bash
npx oddkit init --project
```

This writes to `<repo>/.cursor/mcp.json` instead.

### Verify

After init, Cursor should show oddkit tools. You can also verify from CLI:

```bash
npx oddkit librarian -q "What is epistemic challenge?" -r .
```

If Cursor shows the oddkit tools (`oddkit_orchestrate`, `oddkit_librarian`, etc.), you're wired.

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
