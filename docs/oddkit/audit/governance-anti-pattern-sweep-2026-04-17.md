---
title: Governance Anti-Pattern Sweep — All oddkit Tools
date: 2026-04-17
audience: maintainer
tier: 2
stability: stable
voice: technical
status: active
governs: workers/src/orchestrate.ts, workers/src/index.ts, src/core/tool-registry.js
tags: ["audit", "vodka-architecture", "refactor", "governance"]
---

# Governance Anti-Pattern Sweep — All oddkit Tools

## Summary

Following PR #100's voice-dump suppression bug — where canon-driven detection worked internally but the public MCP schema rejected 6 of 9 modes for 1h 39m of production breakage — this audit inspects every oddkit tool for the same Vodka anti-pattern: **canon defines the vocabulary, but code hardcodes the interpretation**.

Five of eleven tools carry the anti-pattern. Two are SEVERE and silently broken (`validate` ignores its own canon). Two are PARTIAL (`encode`, `preflight`). One cross-cutting issue (mode enum quadruplication) is already named in PR #102's commit message as a follow-up.

Audit method: direct inspection of `workers/src/orchestrate.ts` (2338 lines) and `workers/src/index.ts` (872 lines), cross-referenced against H2 of `odd/ledger/journal/2026-04-17-pr100-rage-quit-handoff.md`.

## Findings by tool

### SEVERE — same anti-pattern class as PR #100

#### `orient`

| # | Issue | Location | What canon should define |
|---|-------|----------|--------------------------|
| 1 | `MODE_SIGNALS` — 12 hardcoded English regex defining what counts as exploration/planning/execution mode | `orchestrate.ts:279` | `odd/orient/mode-signals.md` (vocabulary per mode) |
| 2 | Per-mode questions — three hardcoded English question triplets returned to caller | `orchestrate.ts:1490` | `odd/orient/questions-by-mode.md` |
| 3 | "Proactive posture" prose — 70-word paragraph baked as string literal | `orchestrate.ts:1528` | `canon/values/proactive-posture.md` (canonical text fetched at runtime) |
| 4 | Assumption-marker regex — `is\|are\|will\|should\|must\|always\|never\|obviously\|clearly` | `orchestrate.ts:1480` | `odd/orient/assumption-markers.md` (vocabulary doc) |

The "Proactive posture" prose is the most visible Vodka violation in the codebase. It is the exact text returned by `oddkit_orient` to every caller. Canon updates do not reach users until the worker is redeployed.

#### `gate`

| # | Issue | Location | What canon should define |
|---|-------|----------|--------------------------|
| 1 | `detectTransition` — six hardcoded English regex mapping phrases to transition pairs | `orchestrate.ts:315` | `odd/gate/transition-signals.md` |
| 2 | Per-transition prereqs — five hardcoded transition tuples with hardcoded English prereq descriptions | `orchestrate.ts:1916` | `odd/gate/prerequisites-by-transition.md` |
| 3 | `checkPatterns` — eight hardcoded regex per prereq ID; new canon prereq → silent failure unless code updated | `orchestrate.ts:1956` | Same canon doc, with `evidence_pattern` field per prereq |

#### `validate`

| # | Issue | Location | What canon should define |
|---|-------|----------|--------------------------|
| 1 | `isFinalization` — hardcoded English `commit\|pr\|merge\|ship\|deploy\|release\|publish\|finalize\|submit\|deliver` | `orchestrate.ts:1186` | `canon/definition-of-done.md` (finalization markers) |
| 2 | Hardcoded journal/changelog/version evidence checks | `orchestrate.ts:1188-1194` | Same canon doc (evidence requirements) |
| 3 | **Validate gates "done" but does not read `definition-of-done.md` at all.** Preflight surfaces it; validate ignores it. The two tools have inconsistent definitions of "done." | structural | Validate must read the same doc preflight surfaces |

This is the most surprising finding. `validate`'s entire purpose is to gate completion claims, yet it never consults the canonical definition of done. Refactor priority is high not because the code is dense but because the contract is silently broken.

### PARTIAL — discovery is canon-driven but interpreter is hardcoded

#### `encode`

| # | Issue | Location | What canon should define |
|---|-------|----------|--------------------------|
| 1 | `discoverEncodingTypes` correctly reads `encoding-type`-tagged articles, parses identity/trigger-words/quality-criteria tables | `orchestrate.ts:336` | ✓ Already canon-driven |
| 2 | `scoreArtifactQuality` treats canon-defined `check` strings as opaque text and hardcodes English keyword matching: `ck.includes("non-empty")`, `ck.includes("number")`, `/must\|must not\|never\|always\|shall/i` | `orchestrate.ts:855` | Quality criteria need a structured grammar canon can declare, not freeform strings the worker keyword-matches |
| 3 | `isStructuredInput` hardcodes the TSV format that `odd/encoding-types/serialization-format` already declares | `orchestrate.ts:757` | Format canon should be the source the parser reads |
| 4 | Default fallback OLDC+H trigger words — acceptable safety fallback, but could equally be a `baseline/encoding-types/` canon directory | `orchestrate.ts:393-405` | Optional |

The scoring interpreter (#2) is the same bug shape as PR #100's mode enum: governance defines vocabulary, code hardcodes interpretation. New criteria added in canon are silently scored as the generic fallback.

**Encoding-of-this-audit demonstrates the bug.** When this audit was first encoded via `oddkit_encode`, prefixed `L:`/`O:`/`D:`/`H:` markers were ignored (input wasn't TSV), and `parseUnstructuredInput` typed almost every paragraph as "Constraint" because the audit text contains "must" and "constraint" throughout. The matching is positional and vocabulary-driven, not semantic.

#### `preflight`

| # | Issue | Location | What canon should define |
|---|-------|----------|--------------------------|
| 1 | Hardcoded "Before claiming done" tail — three English bullets ("Provide visual proof for UI changes", "Include test output for logic changes", "Reference any decisions made") | `orchestrate.ts:1389` | `canon/definition-of-done.md` (the same doc validate should read) |

Small refactor, low risk, naturally bundled with the validate refactor since both should read `definition-of-done.md`.

### CROSS-CUTTING — mode enum quadruplication

The 9-mode vocabulary is now declared in four places:

1. `workers/src/index.ts:170` — unified `oddkit` tool schema
2. `workers/src/index.ts:235` — dedicated `oddkit_challenge` tool schema
3. `src/core/tool-registry.js` — local registry (parallel; fixed in PR #104)
4. `MODE_SIGNALS` in `orchestrate.ts:279` — only knows the 3 epistemic modes; does not acknowledge the 6 writing-lifecycle modes

Canon source of truth: `odd/challenge/stakes-calibration`. Klappy named this as the next refactor target in the PR #102 commit message: *"drop the enum entirely and let canon be the validator. The runtime already validates against the calibration table at fetchStakesCalibration time — having the schema also enforce vocabulary is the same Vodka anti-pattern shape that PR #100 fixed for stop words."*

### CLEAN — no anti-pattern

`challenge` (recently refactored, gold standard), `search`, `get`, `catalog`, `version`, `time`, `cleanup_storage`, `telemetry_public`.

(Earlier classification of `telemetry_policy` as CLEAN was wrong — it had a hardcoded header dictionary next to the canon-fetched policy prose. Reclassified to LOW severity and selected as the canary refactor; see status below.)

## Refactor priority

Revised during planning after the canary was selected and the `core-governance-baseline` contract was drafted. The sequence reflects lessons-first-smallest ordering, not raw severity:

0. **✅ CANARY: `telemetry_policy`** — smallest blast radius; proved the three-tier contract and refactor template. **Shipped to prod 2026-04-18 via oddkit#106 + oddkit#107.** Live smoke confirms `governance_source: "canon"` with 8/8 canon-sourced descriptions. Canon extension to add the Description column shipped via klappy.dev#102.
1. **`validate` + `preflight` (bundled)** — next. Requires writing `canon/constraints/definition-of-done.md` first (currently referenced by user-facing docs but does not exist in the repo). Fixes validate's silently-broken "done" contract.
2. **Mode-enum collapse** — cross-cutting; single source of truth for the 9-mode vocabulary. Already named by Klappy in PR #102 commit.
3. **`orient`** — three issues; "Proactive posture" prose is the headline embarrassment.
4. **`gate`** — three issues; mirrors orient pattern.
5. **`encode` quality interpreter** — same bug class as PR #100; subtle and silent.

## Constraints for future refactors

- **Public-contract verification is mandatory.** Every refactor that touches a tool must include a live-smoke test that invokes the public MCP API and asserts the full response envelope. Internal parser tests are necessary but not sufficient — they passed for the telemetry_policy canary while the tool shipped a broken envelope. See `workers/test/canon-tool-envelope.smoke.mjs` for the template.

- **Response envelope is load-bearing.** Every canon-driven tool must return the full envelope: `{action, result, server_time, assistant_text, debug}`. `server_time` is required on every response so the time-discipline system works. `debug.duration_ms` is required for observability. Missing any of these is a regression against the contract, not an omission.

- **`governance_source` signal required.** Every canon-driven tool must return `result.governance_source: "canon" | "baseline" | "minimal"` so callers can detect degradation. Per `canon/constraints/core-governance-baseline`.

- **`canon_url` parameter required.** Every canon-driven tool must accept `canon_url` in its Zod schema and thread it through to `fetcher.getFile(path, canon_url)`. A tool that hardcodes the baseline canon URL defeats the override contract and breaks custom-canon consumers (TruthKit, private KBs, etc.). The telemetry_policy canary shipped with this gap — the schema was `{}` and MCP silently stripped the parameter.

- **Vocabulary sweeps are non-optional.** Any refactor that touches mode/transition/claim-type vocabulary must verify all four declaration sites (`workers/src/index.ts` ×2, `src/core/tool-registry.js`, `orchestrate.ts`) agree, OR collapse them to a single source of truth.

- **`definition-of-done.md` is load-bearing.** Both `preflight` and `validate` should read it. Inconsistency between them is a contract bug. The canon doc does not currently exist and must be written as part of the validate+preflight refactor.

## Refactor template (definition of done)

Each tool refactor in this sweep ships when all of the following hold:

1. Canon doc(s) the tool reads are present and parsable (or the tool degrades cleanly with `governance_source: "minimal"`)
2. Tool's Zod schema accepts `canon_url` (and any other relevant override parameters)
3. Response envelope includes `{action, result, server_time, assistant_text, debug: {duration_ms}}`
4. `result.governance_source` is one of `canon | baseline | minimal`
5. Live smoke test (`canon-tool-envelope.smoke.mjs` or equivalent) passes against Cloudflare preview deploy
6. Live smoke test passes against prod after promotion
7. Audit row for the tool gets stamped (this doc)

Canary violated #3, #4 (partial — `governance_source` shipped but envelope missing), and #5/#6 (no live smoke existed until after the fact). The follow-up at `klappy/oddkit#108` closes those gaps and adds the smoke test to the repo.

## Handoff

This audit is ready to inform planning. Recommend a separate session-by-tool refactor cadence rather than a single megabranch — the PR #100 sprawl (5 PRs for one feature) is the exact failure mode larger scope would amplify.
