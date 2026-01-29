# oddkit

Agent-first CLI for ODD-governed repos. Portable Librarian + Validation with baseline knowledge.

## Documentation

| Doc                                                               | What It Covers                  |
| ----------------------------------------------------------------- | ------------------------------- |
| [**System Overview**](docs/getting-started/odd-agents-and-mcp.md) | How all the pieces fit together |
| [**Agents Guide**](docs/getting-started/agents.md)                | Set up Epistemic Guide + Scribe |
| [**Ledger Guide**](docs/getting-started/ledger.md)                | Learnings and decisions capture |
| [**QUICKSTART**](docs/QUICKSTART.md)                              | CLI and MCP setup in 60 seconds |
| [**MCP Reference**](docs/MCP.md)                                  | Full MCP integration details    |

## Quick Start

```bash
# Install dependencies
npm install

# Build index (optional, auto-builds on first query)
oddkit index

# Ask a policy question
oddkit librarian --query "What is the definition of done?"

# Validate a completion claim
oddkit validate --message "Done with the UI update. Screenshot: ui.png"

# Explain the last result in human-readable format
oddkit explain --last
```

## Commands

### `oddkit index`

Build or rebuild the document index.

```bash
oddkit index --repo /path/to/repo
```

### `oddkit librarian`

Ask a policy or lookup question. Returns citations with quotes.

```bash
oddkit librarian --query "What is the rule about visual proof?" --format json
```

Options:

- `-q, --query <text>` — The question to ask (required)
- `-r, --repo <path>` — Repository root (default: current directory)
- `-f, --format <type>` — Output format: `json` or `md` (default: `json`)

### `oddkit validate`

Validate a completion claim. Returns verdict + evidence gaps.

```bash
oddkit validate --message "Shipped the new feature" --format json
```

Options:

- `-m, --message <text>` — The completion claim (required)
- `-r, --repo <path>` — Repository root (default: current directory)
- `-a, --artifacts <path>` — Optional JSON file with additional artifacts
- `-f, --format <type>` — Output format: `json` or `md` (default: `json`)

### `oddkit explain`

Explain the last oddkit result in human-readable format.

```bash
oddkit explain --last
oddkit explain --last --format json
```

Options:

- `--last` — Explain the last result (default: true)
- `-f, --format <type>` — Output format: `md` or `json` (default: `md`)

The explain command:

- Shows what happened (status/verdict)
- Explains why it happened (which rules fired)
- Suggests what to do next
- Lists evidence used (citations, origin)
- Includes debug info (baseline ref, timestamp)

## Baseline Knowledge

By default, oddkit loads the [klappy.dev](https://github.com/klappy/klappy.dev) repo as baseline knowledge.

### Resolution Order

1. `--baseline <path-or-git-url>` CLI flag (highest priority)
2. `ODDKIT_BASELINE` environment variable (path or git URL)
3. Default: `https://github.com/klappy/klappy.dev`

### Configuration

```bash
# Override baseline via CLI flag
oddkit librarian -q "What is done?" --baseline /path/to/local/canon
oddkit librarian -q "What is done?" --baseline https://github.com/yourorg/your-canon.git

# Override baseline via environment variable
export ODDKIT_BASELINE="https://github.com/yourorg/your-canon.git"
oddkit librarian -q "What is done?"

# Pin to a specific branch/tag
export ODDKIT_BASELINE_REF="v1.0.0"
oddkit librarian -q "What is done?"
```

### Cache Location

- Git repos are cloned to `~/.oddkit/cache/<repo-name>/<ref>/`
- Local paths are used directly (no caching)
- Local docs can override baseline via `supersedes` frontmatter field

## Supersedes Override

A local doc can override a baseline doc by declaring:

```yaml
---
supersedes: klappy://canon/definition-of-done
---
```

The baseline doc with that URI will be suppressed from results.

## Output Format

### Librarian JSON

```json
{
  "status": "SUPPORTED",
  "answer": "Found 3 relevant document(s)...",
  "evidence": [
    {
      "quote": "MUST provide visual proof...",
      "citation": "canon/visual-proof.md#Operating Constraints",
      "origin": "baseline"
    }
  ],
  "read_next": [{ "path": "canon/definition-of-done.md#DoD", "reason": "Primary source" }]
}
```

### Validate JSON

```json
{
  "verdict": "NEEDS_ARTIFACTS",
  "claims": ["Done with the UI update"],
  "required_evidence": ["screenshot", "visual artifact"],
  "provided_artifacts": [],
  "gaps": ["screenshot", "visual artifact"]
}
```

## For Agents

This CLI is designed to be called by AI agents:

```bash
# Agent asks a question
oddkit librarian -q "What evidence is required for UI changes?" -f json

# Agent validates completion
oddkit validate -m "Implemented search with autocomplete. Screenshot: search.png" -f json
```

JSON output is canonical and machine-parseable.
