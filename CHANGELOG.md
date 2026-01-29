# Changelog

All notable changes to oddkit will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-01-29

### Added

- **ODD Agents documentation** — Comprehensive setup guide for Epistemic Guide and Scribe subagents:
  - `docs/getting-started/agents.md` — Full agent setup and usage guide
  - `docs/getting-started/ledger.md` — Learnings and decisions capture guide
  - `docs/getting-started/odd-agents-and-mcp.md` — System overview showing how all pieces connect

- **Ledger system** — Per-project memory for learnings and decisions:
  - `odd/ledger/learnings.jsonl` — Append-only ledger for discoveries
  - `odd/ledger/decisions.jsonl` — Append-only ledger for choices with rationale
  - `odd/ledger/README.md` — Quick reference for ledger format and schemas
  - Seeded with initial entries for canon-target-first freshness and system decisions

- **Policy tools** — New MCP tools for canon target freshness checks:
  - `oddkit_policy_version` — Returns oddkit version and authoritative canon target (commit/mode)
  - `oddkit_policy_get` — Fetches canonical doc by klappy:// URI at current canon target
  - New module `src/policy/canonTarget.js` — Resolves authoritative canon target
  - New module `src/policy/docFetch.js` — Fetches docs by URI with content hash
  - New test `tests/policy-tools.test.sh`

### Changed

- **README.md** — Added documentation table linking to all guides
- **QUICKSTART.md** — Added "What's in the Box" section explaining the three layers (CLI, MCP, Agents)

## [0.3.0] - 2026-01-29

### Added

- **MCP Resource support** - Exposes `oddkit://instructions` as a fetchable resource so Cursor shows "1 resources" and agents can retrieve full instruction text on demand.
  - MUST lines baked into `oddkit_orchestrate` tool description (unavoidable in tool-selection context)
  - Debug logging via `ODDKIT_DEBUG_MCP=1` env var

## [0.2.0] - 2026-01-29

### Added

- **PREFLIGHT action** - Pre-implementation consultation that returns relevant files, constraints, DoD, and pitfalls without injecting doc content. Agents can now run a cheap preflight check before code changes.
  - Triggers on: "preflight:", "before I implement", "what should I read first", "what constraints apply", or compound triggers (implementation verb + target like "implement catalog")
  - Returns: start_here, next_up, constraints_docs, dod, pitfalls, suggested_questions
  - New file: `src/tasks/preflight.js`

- **CATALOG action** - Discoverability menu for ODD docs without content injection.
  - Triggers on: "what's in ODD?", "list the canon", "what should I read?", "show me the doctrines"
  - Returns: start_here, next_up, canon_by_tag, playbooks
  - New file: `src/tasks/catalog.js`

- **Short MUST instructions** - MCP handshake instructions rewritten to be brutally short and imperative so models actually follow them.
  - "MUST: Before editing files or implementing a spec, call oddkit_orchestrate"
  - "MUST: Before claiming done, call oddkit_orchestrate with completion claim + artifacts"
  - New file: `src/mcp/instructions.js`

- **Test coverage** for preflight and catalog actions
  - `tests/orchestrate-preflight.test.sh`
  - `tests/orchestrate-catalog.test.sh`
  - `tests/mcp-instructions-smoke.sh`

### Changed

- Detection order in orchestrate is now: PREFLIGHT -> CATALOG -> EXPLAIN -> VALIDATE -> LIBRARIAN (default)
- Updated `docs/MCP.md` with PREFLIGHT and CATALOG documentation
- Updated `docs/QUICKSTART.md` with preflight workflow

## [0.1.0] - 2026-01-28

### Added

- Initial release with librarian, validate, and explain tools
- MCP server integration for Cursor and Claude Code
- Baseline canon support with supersedes resolution
- Antifragile orchestrator that never returns NO_ACTION
- Compass prompts for agent guidance
- tooljson contract for structured tool output
