# Changelog

All notable changes to oddkit will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-01-29

### Added

- **INSTRUCTION_SYNC action** — New orchestrate action for instruction dependency analysis:
  - Detects when upstream dependencies (canon docs, tool schemas, charters) have changed
  - Computes content hashes and compares against stored state
  - Returns impact sets (must_update, should_update, nice_to_update) and patch plans
  - Supports filesystem mode (`baseline_root`) and payload mode (`registry_payload`)

- **normalizeRef utility** (`src/utils/normalizeRef.js`) — Strict ref normalization with explicit scheme allowlist:
  - Requires `scheme://path` format (non-empty path)
  - Allowed schemes: `klappy://`, `oddkit://`
  - Strips `.md` extension, collapses repeated slashes, removes trailing slash

- **instructionSync task** (`src/tasks/instructionSync.js`) — Core sync logic:
  - Resolves instruction paths by owner (`klappy.dev` → baseline, `oddkit` → repo)
  - Resolves dependency paths with extension probing (`.md` fallback)
  - Tracks dependency hashes (SHA-256, 8-char prefix)
  - Returns sorted state keys and unresolved refs list

- **Runtime parameter validation** — XOR enforcement for instruction_sync params:
  - Must provide either `baseline_root` OR `registry_payload` (not both, not neither)
  - `state_payload` requires `registry_payload` (payload mode only)
  - Message optional for instruction_sync, required for all other actions

- **Test coverage** (`tests/orchestrate-instruction-sync.test.sh`) — Routing and validation tests

### Changed

- **orchestrate.js** — Added INSTRUCTION_SYNC to ACTIONS enum, validation function, dispatch case
- **server.js** — Passes through `baseline_root`, `registry_payload`, `state_payload` to orchestrate
- **oddkit.tools.json** — Added `instruction_sync` to action enum

### Philosophy

- **No auto-editing** — instruction_sync only reports impact and patch plans; it never edits instruction docs
- **Schema permissive, runtime enforces** — JSON schema allows params; runtime validates correctness
- **Annoying but safe** — Drift detection surfaces staleness without blocking work

## [0.5.0] - 2026-01-29

### Added

- **OddKit Charter** (`docs/oddkit/CHARTER.md`) — Authoritative contract defining oddkit's identity as epistemic terrain rendering:
  - What oddkit derives (catalog structure, tag groupings, relevance)
  - What oddkit refuses to infer (epistemic mode, user intent, confidence)
  - What oddkit requires from upstream (explicit action, epistemic context)

- **ORIENT action** — First-class action for map-first navigation:
  - Action-driven only (caller passes `action: "orient"`)
  - No phrase detection or inference from message content
  - Returns epistemic terrain with contextual suggestions based on mode

- **Epistemic context parameter** — Canon-derived mode awareness:
  - `epistemic.mode_ref` — Canon URI (e.g., `klappy://canon/epistemic-modes#exploration`)
  - `epistemic.confidence` — Caller-declared confidence level (`low|partial|strong|verified`)
  - `suggest_orient` hint when exploration + low confidence (advisory only)

- **Epistemic retrieval bias** — Soft retrieval adaptation based on mode:
  - Exploration: boosts overview/getting-started/principles docs (1.2x)
  - Planning: boosts constraints/dod/decisions/governing docs (1.25x)
  - Execution: boosts operational/how-to/commands docs (1.15x)
  - Full observability via `debug.retrieval_policy`

### Changed

- **README.md** — Added charter pointer ("OddKit is epistemic terrain rendering, not epistemic authority")
- **orchestrate.js** — Added ORIENT action, explicit `action` parameter, epistemic context threading
- **scoring.js** — Added `computeEpistemicBias()` with mode-aware multipliers
- **librarian.js** — Accepts epistemic context, surfaces retrieval_policy in debug
- **instructions.js** — Documented action parameter and epistemic context (v0.5.0)
- **tools/oddkit.tools.json** — Added `action` and `epistemic` parameters to orchestrate schema

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
