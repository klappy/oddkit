# Changelog

All notable changes to oddkit will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.12.1] - 2026-02-07

### Fixed

- **MCP tool discovery for OpenAI Agent Builder** — Resolved persistent 424 (Failed Dependency) error with three fixes:
  - **Missing `serverInfo.version`** — `ODDKIT_VERSION` env var was undefined in production; `JSON.stringify` silently dropped it, violating the MCP Implementation schema (requires both `name` and `version`). Now imports version from `package.json` at build time via wrangler/esbuild — no env var dependency, no drift.
  - **SSE responses for POST requests** — OpenAI sends `Accept: application/json, text/event-stream` and requires `text/event-stream` responses. Server was only returning `application/json`. Now returns SSE format (`event: message` + `data:` lines) when client accepts `text/event-stream`.
  - **Batch JSON-RPC support** — MCP spec allows arrays of JSON-RPC messages in a single POST. Server only handled single messages, causing `method: undefined` errors on batches. Added `Array.isArray` detection with per-message processing.

- **Version consistency across all endpoints** — `/health`, `/.well-known/mcp.json`, and MCP `initialize` all use `BUILD_VERSION` fallback from `package.json` when `ODDKIT_VERSION` env var is missing.

### Changed

- **Production tests** — Added 4 new test cases: `serverInfo.version` presence (4e), SSE Content-Type for POST (4f), SSE data format validation (4g), batch JSON-RPC support (4h).

## [0.12.0] - 2026-02-05

### Added

- **Efficient change detection** — Check if canon repos have changed without downloading content:
  - **CLI**: `checkRemoteForChanges()` uses `git ls-remote` to fetch only refs (~100 bytes)
  - **Worker**: `checkForChanges()` uses GitHub API with SHA-only Accept header
  - **Helper module**: `src/baseline/checkForChanges.js` provides `checkBaselineForChanges()`
  - `ensureBaselineRepo()` now supports `checkOnly` and `skipFetchIfUnchanged` options
  - Returns `changed`, `currentSha`, `cachedSha` for observability
  - Worker caches commit SHA in KV and compares before re-fetching ZIPs
  - Dramatically reduces bandwidth when source repos haven't changed

- **Commit SHA tracking** — Index now includes `commit_sha` and `canon_commit_sha` for reproducibility and change detection

### Fixed

- **Cache invalidation now clears R2 ZIP cache** — Previously `invalidate_cache` only cleared the KV index (5 min TTL) but left the R2 ZIP cache (24 hour TTL) intact, causing stale data to be served. Now clears:
  - KV index cache
  - KV SHA caches (for change detection)
  - R2 ZIP cache for baseline and canon repos
  - Memory caches (ZIP and commit)

- **Fresh fetch on index rebuild** — When rebuilding the index (cache miss or change detected), always fetch fresh ZIPs instead of using potentially stale R2 cache

## [0.11.0] - 2026-02-05

### Added

- **ZIP-based baseline fetching** — Remote MCP worker now fetches entire repos as ZIP files instead of expecting pre-built index:
  - Fetches repo ZIP from GitHub (e.g., `https://github.com/klappy/klappy.dev/archive/main.zip`)
  - Extracts markdown files lazily using `fflate` library
  - Builds index dynamically from `canon/**/*.md`, `odd/**/*.md`, `docs/**/*.md`
  - Parses YAML frontmatter for title, intent, authority_band, tags, uri

- **Tiered caching architecture** — Inspired by translation-helps-mcp:
  - **KV cache** — Index cached for 5 minutes
  - **R2 bucket** — ZIP files and extracted documents cached for fast access
  - **Memory cache** — In-flight request deduplication
  - New bindings in `wrangler.toml`: `BASELINE_CACHE` (KV), `BASELINE_R2` (R2)

- **Canon repo override** — Projects can override klappy.dev baseline with custom canon:
  - New `canon_url` parameter on `oddkit_orchestrate`, `oddkit_librarian`, `oddkit_catalog`
  - Canon docs override baseline docs with same path/uri
  - Arbitration merges unique docs from both sources
  - Example: `{ "message": "what's in ODD?", "canon_url": "https://github.com/myorg/mycanon" }`

- **New MCP tools**:
  - `oddkit_catalog` — Lists available documentation with counts by source (canon vs baseline)
  - `oddkit_invalidate_cache` — Force refresh of cached baseline/canon data

- **New file**: `workers/src/zip-baseline-fetcher.ts` — Tiered cache implementation with ZIP extraction

### Fixed

- **"0 documents" issue** — Remote MCP worker no longer requires pre-built `.oddkit/index.json` in baseline repo. Index is now built dynamically from repo content.

### Changed

- **orchestrate.ts rewritten** — Now uses `ZipBaselineFetcher` instead of raw GitHub fetch
- **Scoring improved** — Entries scored by term matching with boosts for governing/promoted docs and canon source

## [0.10.1] - 2026-02-02

### Fixed

- **MCP Streamable HTTP transport hang** — Claude Code's MCP client was hanging with AbortError when calling tools:
  - Added `Mcp-Session-Id` header on initialize response (required by MCP 2025-03-26 spec)
  - Added GET request support for SSE streaming connections
  - Added DELETE request support for session termination
  - Updated protocol version from 2024-11-05 to 2025-03-26
  - Updated CORS headers to include MCP-specific headers (Accept, Mcp-Session-Id, Last-Event-ID)

### Changed

- **Production tests** — Updated to test protocol version 2025-03-26 and new transport features
- **Deployment** — Worker deploys automatically via GitHub webhook on push to main (no manual `npm run deploy` needed)

## [0.10.0] - 2026-02-02

### Added

- **Cloudflare Workers deployment** — Remote MCP server for Claude.ai on iOS/iPad/web:
  - New `workers/` directory with Cloudflare Worker implementation
  - Streamable HTTP transport for MCP communication
  - Fetches baseline from GitHub raw content API (no git clone required)
  - Full MCP capabilities: tools, resources, and prompts
  - CORS enabled for cross-origin requests
  - Deploy with `cd workers && npm run deploy`

- **Three deployment methods** — oddkit now runs everywhere:
  - **CLI** — `npx oddkit <command>` for terminal usage
  - **MCP (local)** — `npx oddkit-mcp` for Cursor/Claude Code
  - **MCP (remote)** — Cloudflare Worker for Claude.ai mobile/web

- **MCP resources in Worker** — Same resources as CLI version:
  - `oddkit://instructions` — Decision gate
  - `oddkit://quickstart` — Agent quick start
  - `oddkit://examples` — Usage patterns

- **MCP prompts in Worker** — Fetched live from baseline registry:
  - Agent prompts like odd-epistemic-guide, odd-scribe
  - Loaded from `klappy.dev/canon/instructions/REGISTRY.json`

### Changed

- **Updated documentation** — All docs now cover CLI, npx, and HTTP deployment methods

## [0.9.1] - 2026-02-02

### Fixed

- **CLI version now reads from package.json** — `oddkit --version` was hardcoded as 0.1.0, now correctly shows the actual version

## [0.9.0] - 2026-02-02

### Added

- **Claude Code integration** — First-class support for Claude Code:
  - `oddkit init --claude` — Configure `~/.claude.json` for Claude Code
  - `oddkit init --all` — Configure both Cursor and Claude Code at once
  - Auto-detects Claude Code environment and defaults to claude target

- **CLAUDE.md generator** — New command `oddkit claudemd`:
  - Generates project-level context file for Claude Code
  - Includes oddkit integration instructions and examples
  - `--advanced` flag for epistemic mode documentation
  - Safe append to existing CLAUDE.md files

- **Claude Code hooks** — New command `oddkit hooks`:
  - Generates `.claude/settings.local.json` with Claude Code hooks
  - Detects completion claims and reminds about validation
  - `--minimal` for basic completion detection
  - `--strict` for preflight reminders before edits

- **Enhanced MCP resources** — Better context for spawned agents:
  - `oddkit://quickstart` — Essential patterns for subagents
  - `oddkit://examples` — Common usage patterns with examples
  - Improved `oddkit://instructions` with spawned agent guidance

- **Documentation** — New `docs/CLAUDE-CODE.md`:
  - Claude Code specific setup guide
  - Spawned agent usage patterns
  - Troubleshooting and configuration reference

### Changed

- **MCP targets are now configurable** — `oddkit init` supports:
  - `--cursor` — Cursor config (previous default)
  - `--claude` — Claude Code config
  - `--project` — Project-local config for either target

- **Updated instructions** — MCP instructions now include spawned agent guidance

## [0.8.1] - 2026-01-31

### Changed

- **MCP prompts now load from registry** — DRY/KISS approach:
  - Prompts dynamically loaded from `klappy.dev/canon/instructions/REGISTRY.json`
  - All agents in registry automatically available as MCP prompts
  - Single source of truth: update agents in klappy.dev, all consumers get updates
  - Removes hardcoded `oddkit_compass` and `oddkit_compass_prd` prompts

## [0.8.0] - 2026-01-31

### Added

- **ODD Orchestrator** — Unified Guide + Scribe for mode-aware agentic work:
  - Tracks epistemic mode (discovery/planning/execution) with distinct postures
  - Discovery: High fuzziness tolerance, constructive adversarial pushback
  - Planning: Options crystallizing, decisions locking, constraints surfacing
  - Execution: Concrete, locked, artifact delivery

- **Mode transitions with gates** — Prevents premature advancement:
  - Discovery → Planning: requires captured requirements and defined scope
  - Planning → Execution: requires DoD, constraints, and locked decisions
  - Execution → Discovery: requires completion claimed and validated

- **Scribe smell detection** — Captures learnings/decisions in flight:
  - Detects learning signals ("realized", "discovered", "turns out")
  - Detects decision signals ("decided to", "choosing", "going with")
  - Detects override signals ("actually", "scratch that", "correction")
  - Consent-gated capture to `odd/ledger/*.jsonl`

- **Session state persistence** — Maintains mode across MCP calls:
  - State stored in `~/.oddkit/orchestrator-state.json`
  - Auto-expires after 1 hour of inactivity
  - Explicit `reset_session` parameter to start fresh

- **New MCP tool `oddkit_orchestrator`** — Parameters:
  - `message` — User message or context
  - `mode` — Explicit mode override
  - `transition_to` — Request mode transition
  - `capture_consent` / `capture_entry` — Consent-gated ledger capture
  - `reset_session` — Reset to fresh discovery mode

- **New files:**
  - `src/orchestrator/mode.js` — Mode definitions with postures
  - `src/orchestrator/state.js` — Session state persistence
  - `src/orchestrator/transitions.js` — Mode transition rules
  - `src/orchestrator/guide.js` — Posture enforcement, action gating
  - `src/orchestrator/scribe.js` — Smell detection, ledger capture
  - `src/orchestrator/index.js` — Main orchestrator

### Philosophy

- **Guide + Scribe as minimal core** — Everything else can be an extension
- **Mode-appropriate posture** — Behavior adapts to epistemic phase
- **Consent-gated capture** — Scribe proposes, human decides
- **Extension pattern** — When guide fails, extract the concern as a specialist

## [0.7.0] - 2026-01-30

### Added

- **sync-agents command** — Human-triggered installer for agent files from baseline to Cursor:
  - Dry-run by default (shows patch plan, no writes)
  - `--apply` flag to actually copy files
  - `--backup` (default ON) creates timestamped backups before overwriting
  - `--only <agents>` filters to specific agent subset
  - `--from baseline` forces baseline refresh before diff
  - `--dest <path>` overrides default Cursor agents directory
  - `--verbose` shows unchanged files and hashes

- **Safety rules (non-negotiable):**
  - Never writes into baseline repo
  - Never auto-runs on MCP calls
  - Never overwrites without `--apply` AND printing patch plan first
  - Always hashes bytes before/after for verification

### Philosophy

- **Manual install stays the authority gate** — Default posture preserves ODD premise (no silent mutation of operational truth)
- **Convenience without compromise** — Removes "copy files manually" tax while keeping human control
- **Deterministic patch plans** — Shows exactly what will change before any write

## [0.6.1] - 2026-01-29

### Fixed

- **instruction_sync return contract** — Now returns standard `{ action, assistant_text, result, debug, suggest_orient }` structure instead of non-standard `{ action, ok, result }`. Callers depending on the documented contract at line 287 will no longer fail.
- **buildInstructionSyncAssistantText** — Added helper function to generate human-readable output showing sync timestamp, registry version, impact summary, and unresolved dependencies.

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
