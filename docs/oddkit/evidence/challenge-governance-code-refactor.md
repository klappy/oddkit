# Gauntlet Evidence — Challenge Governance Code Refactor

**Branch:** `feat/e0008-challenge-governance-driven`
**Date:** 2026-04-17
**Scope:** Governance-driven refactor of `oddkit_challenge` in `workers/src/orchestrate.ts` plus minor extension of `workers/src/bm25.ts`
**Deliverable type:** Worker code change (TypeScript) — the runtime that consumes the canon governance articles landed in PR #99
**Predecessor PRs:** #96 (governance-driven encode pattern, the structural mirror), #99 (klappy.dev governance articles, the canon this code reads)

---

## Definition of Done — Evidence

### 1. Change Description

Refactored `runChallengeAction` in `workers/src/orchestrate.ts` from hardcoded claim-type detection and question generation to governance-driven extraction. The structural mirror of PR #96 (encode). **Mid-implementation pivot:** replaced regex-OR detection with BM25 + stemming after the gauntlet surfaced a morphological brittleness (`"coin"` doesn't match trigger word `"coining"`). The architectural swap removed an entire class of bug and validated a reusable pattern for future governance-driven tools.

**New types added (`orchestrate.ts`):**

- `ChallengeTypeDef` — slug, name, blockquote, trigger words, `detectionText` (triggers + blockquote, fed to BM25 indexer), questions with tiers, prerequisite overlays, reframings, fallback flag
- `BasePrerequisite` — prerequisite name, check description, gap message
- `NormativeVocabulary` — case-sensitive regex (RFC 2119), case-insensitive regex (architectural phrases), directive type map (this one keeps regex since it's directive-vocabulary matching against retrieved canon quotes, not claim-type detection)
- `StakesModeConfig` / `StakesCalibration` — mode → (question tiers, prerequisite strictness, reframing surfacing)

**New discovery/fetch functions added (`orchestrate.ts`):**

- `discoverChallengeTypes(fetcher, canonUrl)` — finds articles tagged `challenge-type`, parses each, builds a per-canonUrl BM25 index over detection text. Per-canonUrl cache for types AND index.
- `fetchBasePrerequisites(fetcher, canonUrl)` — fetches `odd/challenge/base-prerequisites.md`, extracts the prerequisite overlays table. Per-canonUrl cache.
- `fetchNormativeVocabulary(fetcher, canonUrl)` — fetches `odd/challenge/normative-vocabulary.md`, extracts both vocabulary tables, compiles case-sensitive and case-insensitive regexes. Falls back to minimal RFC 2119 set if the article is missing. Per-canonUrl cache.
- `fetchStakesCalibration(fetcher, canonUrl)` — fetches `odd/challenge/stakes-calibration.md`, extracts the calibration table. Per-canonUrl cache.

**`runChallengeAction` refactored to:**

- Load all four governance sources in parallel
- Honor voice-dump suppression invariant — return empty challenge output when mode's tier list is empty
- Detect matching types via BM25 over per-type detection text (score > 0 = match)
- Resolve fallback type when no type scores > 0
- Aggregate questions, prerequisite overlays (base + type), and reframings across matched types with deduplication
- Apply stakes calibration filter based on mode (question tiers, prerequisite strictness, reframing surfacing)
- Detect tensions in retrieved canon quotes via governance-driven vocabulary regex (replacing hardcoded `MUST`/`MUST NOT` checks)
- Surface matched type names and definitions in the response (teaching the model what governs the behavior)
- Mark `block_until_addressed` when calibration says so

**`evaluatePrerequisiteCheck` helper added:** interprets natural-language `check` strings from prerequisite overlay tables. Extracts quoted keywords and tests presence in input. Special-cases URL, numeric, proper-noun, and citation patterns.

**`runCleanupStorage` extended:** clears all five new caches (types, type-index, base prerequisites, normative vocabulary, stakes calibration). Mirror of the PR #96 fix for cache staleness on governance edits.

**Dead code removed:** `detectClaimType` in `workers/src/orchestrate.ts` (only used by the old hardcoded `runChallengeAction`). Legacy version in `src/tasks/challenge.js` retained for backward-compat on the non-worker CLI path.

**`workers/src/bm25.ts` extension (backward-compatible):**

- `tokenize(text, stopWords?)` — new optional parameter. Defaults to the existing `STOP_WORDS` set (unchanged behavior for existing callers).
- `buildBM25Index(documents, stopWords?)` — same. Records the stop word set on the returned index so `searchBM25` tokenizes queries consistently with doc vocabularies.
- `BM25Index` interface gained an optional `stopWords?: Set<string>` field.
- Motivation: the default `STOP_WORDS` filters out modal verbs (`must`, `should`, `shall`, `may`, `not`) which are the load-bearing detection signal for strong-claim, proposal, and assumption challenge types. Challenge-type detection needs a custom stop-word set that preserves modals.

### 2. Verification Performed

- `npm run typecheck` (workers/) — clean both before and after the BM25 pivot, and after the dead-code removal
- `bash tests/smoke.sh` (root) — 6 PASS, exercising the legacy CLI path. Confirms backward compat preserved (the worker path I refactored is separate from the CLI path).
- `node workers/test/governance-parser.test.mjs` — new parser-fidelity test, 94 assertions against live governance articles fetched from klappy.dev raw. **94 pass, 0 fail.** Includes explicit regression tests for stemming (`coin`/`coining`, `proposed`/`propose`, `principles`/`principle`) and multi-match semantics via BM25.
- `oddkit_preflight` — surfaced constraints (ai-voice-cliches, author-identity-language, definition-of-done, supersession, prompt-over-code)
- `oddkit_get` on `canon/methods/supersession.md` — confirmed this refactor is "replace" on the supersession spectrum (provenance preserved via PR description, commit message, ledger entry, retained legacy file)
- AI voice clichés audit on new code/comments via `git diff | grep` for negation parallelism, formulaic transitions, puffing — clean, zero hits
- `oddkit_challenge` on the commit decision — generic prereqs answered honestly in the PR description
- `oddkit_gate` returned NOT_READY for the same hardcoded-logic reason documented in PR #99 — flagged in PR as future refactor candidate

### 3. Observed Behavior

Parser-fidelity test output (94/94 passed):

```
─── Test 1: Challenge type parsing ───  (7 types × 8 assertions = 56 passing)
─── Test 2: Fallback resolution ───  (2 passing — observation has fallback: true, others don't)
─── Test 3: BM25 detection with stemming ───  (7 passing — each type matches its first trigger word)
─── Test 3b: Stemming defeats the original coin/coining bug ───  (5 passing — stemming equivalence + 4 real-world inputs)
─── Test 4: Multi-match semantics (BM25) ───  (3 passing)
─── Test 4b: Empty input + irrelevant input do not over-match ───  (1 passing)
─── Test 5: Base prerequisites ───  (4 passing)
─── Test 6: Normative vocabulary ───  (4 passing)
─── Test 7: Stakes calibration ───  (5 passing — including the voice-dump suppression invariant)

94 passed, 0 failed
```

### 4. Evidence Produced

This file. Plus the diffs:

- `workers/src/orchestrate.ts`: ~560 insertions, ~70 deletions
- `workers/src/bm25.ts`: small additive change (stopWords parameter threaded through tokenize/buildBM25Index/searchBM25, no behavior change for existing callers)
- `workers/test/governance-parser.test.mjs`: new (~200 lines)
- `docs/oddkit/evidence/challenge-governance-code-refactor.md`: this note

Visual proof: **N/A — server-side code change.** No UI, no interaction surface, no visible state. The `oddkit_challenge` MCP tool's response shape changes (adds `mode`, `matched_types`, `type_definitions`, `block_until_addressed` fields; removes `claim_type`) but this is consumed programmatically, not rendered.

### 5. Self-Audit Completed

- **Intended outcome:** the worker path of `oddkit_challenge` becomes governance-driven via extraction from canon, mirroring PR #96. Behavior changes when the canon governance articles change — no code redeploy required. Detection is morphologically resilient via BM25 + stemming.
- **Constraints applied:** Definition of Done (this file), Writing Canon (n/a — code, not document, but evidence note follows the structure), AI voice clichés (audited clean on new comments), supersession ("replace" with provenance preserved), prompt-over-code (the principle this implements), Vodka Architecture (server stays thin — extraction and IR, no domain opinion baked in).
- **Decision rules followed:** mirror PR #96's cache pattern (per-canonUrl keying, try-catch-graceful-degradation per article); preserve legacy CLI path; voice-dump suppression as a load-bearing invariant; multi-match by design; honor `fallback: true` frontmatter for type fallback resolution; keep `bm25.ts` changes backward-compatible.
- **Tradeoffs:** four governance fetches per challenge call (mitigated by per-canonUrl module-level cache, so cold start is the only slow path); BM25 index built per cache invalidation (cheap — 5–10 tiny docs); BM25 score magnitudes aren't intuitive constants (anyone tuning thresholds later will need to reason in relative terms); the Porter-style stemmer handles common English morphology but not irregular forms.
- **Remaining risks:**
  - Parser regex assumes specific table column order. If a future governance article reorders columns, parsing degrades silently. The parser-fidelity test catches this for currently-shipped articles but won't catch it for hypothetical future structure changes.
  - `evaluatePrerequisiteCheck` uses heuristics over natural-language check descriptions. Some prerequisite checks may evaluate incorrectly — watch for false-negative gap messages in production logs.
  - `oddkit_gate` still returns NOT_READY due to its own hardcoded prereqs — same architectural pattern as challenge pre-refactor. Future refactor candidate. Documented in PR.
  - `oddkit_encode` still uses regex-OR detection with the same morphological brittleness this PR fixes for challenge. Follow-up PR required to bring encode to parity; the pivot here provides the blueprint.
  - klappy.dev meta governance article (`odd/challenge-types/how-to-write-challenge-types.md`) describes the runtime as "compiles into a case-insensitive word-boundary regex" — that's now stale. Small coordinated klappy.dev PR required to update the language.

---

## Bugs the Gauntlet Caught (this refactor sequence)

1. **PR #99 — 10 of 11 articles missing required `## Summary` sections.** Writing Canon tier 4 violation. Same failure mode as the Feb 2026 Progressive Disclosure Failure incident.
2. **PR #99 — broken `derives_from` path** in `stakes-calibration.md` (`canon/epistemic-modes.md` → `canon/definitions/epistemic-modes.md`).
3. **This PR — voice-dump suppression invariant would have shipped broken.** The calibration cell content is `"none (suppress all challenge)"` not bare `"none"`. Initial parser checked `=== "none"` with strict equality, would have produced a single-element array, voice-dump mode would have surfaced all challenge questions in production. Fixed by checking `tiersRaw === "none" || tiersRaw.startsWith("none ") || tiersRaw.startsWith("none(")`.
4. **This PR (BM25 pivot) — morphological brittleness revealed.** The test `pattern-coinage fires on 'coin the term'` failed under regex because the article has `coining` as a trigger but not `coin`. This signal triggered the full pivot from regex-OR to BM25 + stemming.
5. **This PR (BM25 pivot) — default `STOP_WORDS` would have silently broken strong-claim and proposal detection.** The default filter drops modal verbs (`must`, `should`, `shall`, `may`, `not`) — exactly the load-bearing trigger words for these two types. Caught because the parser-fidelity test asserted each type matches its first trigger word and two types failed. Fixed by extending `bm25.ts` with an optional `stopWords: Set<string>` parameter and defining a `CHALLENGE_STOP_WORDS` set in `orchestrate.ts` that preserves modals.

**The discipline is load-bearing, not ceremony.** Five real bugs caught across two PRs. Two of the five would have caused silent production failures of invariants specifically named in the governance.

---

## Version Tracking

- Branch: `feat/e0008-challenge-governance-driven`
- Post-merge: ledger entry capturing E0008 challenge code-refactor milestone
- Related PRs:
  - **Predecessor (structural mirror):** klappy/oddkit#96 (governance-driven encode refactor)
  - **Depends on:** klappy/klappy.dev#99 (governance articles in canon — the inputs this code reads)
  - **Immediate follow-up:** encode parity PR — bring `oddkit_encode` to BM25 + stemming using the pattern proven here
  - **Small follow-up:** klappy.dev PR updating `how-to-write-challenge-types.md` — swap "compiles into a case-insensitive word-boundary regex" for the BM25 description
  - **Future candidate:** governance-driven gate refactor (gate has the same hardcoded-logic gap as challenge pre-refactor; surfaced again during this gauntlet run)
