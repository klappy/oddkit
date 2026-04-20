# Changelog

All notable changes to oddkit will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.23.0] - 2026-04-20

> **Version note:** P1.3.4 was scoped as 0.22.0 per the handoff, but two envelope-conformance fixes (PR #124 telemetry, PR #125 catalog) landed on main in parallel and were released as 0.22.0 via PR #128 while this branch was in Sonnet 4.6 validator dispatch. Per `klappy://canon/constraints/release-validation-gate` Rule 3 (canon outranks session artifacts) and SemVer discipline, this refactor is re-versioned to 0.23.0. The handoff's "ship as 0.22.0" recommendation was session-scoped; main-reality is the canon.

### Changed

- **`oddkit_encode` trigger-word classifier migrated from regex alternation to stemmed phrase-subset matching** (per PRD D5 from P1.3.4 — split-by-fit, same matcher family shipped for challenge in 0.21.0 and gate in 0.20.0, adapted for encode's phrasal vocabulary). `EncodingTypeDef.triggerRegex: RegExp | null` is replaced with `stemmedPhrases: string[][]` — each inner array is the ordered stem sequence of a single canon trigger word or phrase, parsed once per canon fetch. The runtime matcher `matchesStemmedPhrases(phrases, inputStems)` declares a match when ALL stems of at least one phrase appear in the input stem set. Single-stem phrases degenerate to set membership (identical to the old behavior for inflection matching like `deciding` → `decid`); multi-stem phrases like `committed to` → `[committ, to]` require both stems to co-occur, so ubiquitous function words like `to`, `with`, `by`, `up`, `out`, `not` cannot fire as standalone match triggers just because they appear inside a canon phrase. This preserves the pre-refactor regex semantic where `\b(committed to)\b` matched only when both words were present. Canon trigger vocabulary reads unchanged from `odd/encoding-types/*.md` (`## Trigger Words` fenced block); the matcher tokenizes each vocabulary entry with stop-words disabled (`tokenize(word, new Set())`) and stores the ordered stem array at parse time, and intersects against a stop-word-disabled stemmed input set at runtime. Inflected forms (`deciding`, `realizing`, `discovering`) now match their canonical stems (`decid`, `realiz`, `discover`) without canon having to enumerate each inflection. **Strictly additive** over the pre-refactor regex: every input that matched still matches (both phrase conjunction and word-boundary semantics preserved), plus stemmed variations of single-word vocab now match additionally. Stop-words disabled on both parse-time and runtime `tokenize()` calls — canon vocab survival is mandatory for the strictly-additive invariant to hold, per the P1.3.3 C-04 precedent. Both classifier call sites preserve their existing semantics: `parsePrefixedBatchInput` untagged-paragraph path picks first match via `break` (one artifact per paragraph); `parseUnstructuredInput` emits one artifact per matching type (no `break` — the load-bearing design comment at L1161–1164 preserved verbatim). `tokenize(para, new Set())` is hoisted once per paragraph into an `inputStems` Set reused across the per-type loop. The phrase-subset match (all stems co-occurring, any order) was adopted mid-PR in response to a high-severity Cursor Bugbot finding on commit `259170a` — the first version's flat `stemmedTokens: Set<string>` would have fired Decision on virtually every English paragraph because the ubiquitous function-word constituents of phrasal canon vocab (`to`, `with`) were being added as standalone singletons. Per `klappy://canon/principles/vodka-architecture`: fit the matcher to the problem shape.

### Removed

- **Module-level `cachedEncodingTypes` in-process cache** (per PRD D9 from P1.3.4 — don't cache microsecond derivations; same pattern challenge shipped in 0.21.0 and gate shipped in 0.20.0). `cachedEncodingTypes`, `cachedEncodingTypesKnowledgeBaseUrl`, `cachedEncodingTypesSource` module-level fields deleted; cache-check short-circuit at the top of `discoverEncodingTypes` deleted; `cleanup_storage` resets for the three fields deleted. Per `klappy://canon/principles/cache-fetches-and-parses`: the fetch layer (Module Memory → Cache API → R2, 5-minute TTL) already caches the canon file content; caching the parse product for microsecond re-derivation savings is the anti-pattern the principle names. Parse runs fresh per call; overhead is sub-millisecond on hot fetches.

### Added

- **New smoke regression assertions in `workers/test/canon-tool-envelope.smoke.mjs`** anchoring the D5 migration and the Bugbot phrase-subset fix: (12) stemmed inflection match — `"I'm deciding to ship the two-tier cascade"` classifies as Decision (`decid` stem degenerate-singleton matches `decided` in canon vocab); (13) stop-word phrase survival — `"we're going with option B after the review"` matches Decision via the `[go, with]` phrase having both stems present in the input set; (14) multi-type preservation — `"We must never deploy without tests because we decided this last week"` emits both `C` and `D` artifacts via the no-break path (`must`/`never` singletons for Constraint; `decid` singleton for Decision); (15) first-match preservation — untagged paragraph in a mixed batch emits exactly one artifact via the batch classifier's `break` semantic; (16) phrase-subset regression anchor — `"I need to wait until tomorrow for the review"` does NOT classify as Decision or Handoff (the pre-Bugbot-fix flat-Set implementation would have fired Decision via standalone `to` and Handoff via standalone `to`/`for`; post-fix, no phrase of either type has all its stems present in the input). Assertion (16) is the Bugbot PR #126 regression anchor and will fail against any revision where multi-word vocab is flattened back into standalone-singleton triggers.

### Refs

- Handoff: `klappy://odd/handoffs/2026-04-20-p1-3-4-encode-canon-parity`
- Canon basis: `klappy://canon/principles/cache-fetches-and-parses`, `klappy://canon/principles/vodka-architecture`
- Precedent: oddkit 0.21.1 (challenge's D5 + D9), 0.20.0 (gate's D5 + D9)
- Shipping gate: `klappy://canon/constraints/release-validation-gate` (binding)
- Bugbot finding dispositioned: PR #126 review `cursor[bot]` 2026-04-20T12:55:03Z (high severity, multi-word vocab flattening) — fix-forward in same PR via Cursor autofix commit `113ba11` (phrase-subset match). The in-session orchestrator proposed a stricter consecutive-subsequence variant; autofix's subset-match was accepted as the simpler design better aligned with encode's multi-type tolerance philosophy.
- Closes the canon-parity sweep — all three tools now use stemmed matching and have their in-process derivation caches removed per `cache-fetches-and-parses`.

## [0.22.0] - 2026-04-20

### Added

- **`index_built_at` on `oddkit_catalog` debug envelope** — catalog now surfaces the index build timestamp under an accurately-named field, preserving the cache-freshness diagnostic alongside the response-time `generated_at`. Landed via klappy/oddkit#125.

### Fixed

- **`telemetry_public` envelope conformance** — previously returned a bare `{action, result}` envelope, missing `server_time`, `assistant_text`, and `debug`. Every other tool — including `telemetry_policy` after PR #108 — already emitted the full envelope. This fix brings `telemetry_public` into conformance with the E0008.2 canon (`klappy://docs/appendices/epoch-8-2`) and adds the missing three fields on both the success path and the not-configured error path. `assistant_text` on success is derived from the row count when the result carries data rows. `result.generated_at` preserved unchanged. Landed via klappy/oddkit#124.

- **`oddkit_catalog` `debug.generated_at` is response time, not cached index timestamp** — `runCatalog` previously returned `generated_at: index.generated_at` — the cached index build timestamp — producing up to 48-minute drift from envelope `server_time` in the same response. Every other handler uses `new Date().toISOString()` for this field. Fix aligns catalog with the same pattern; the cache-build timestamp is preserved as a separate, accurately-named `index_built_at` field (see Added). Landed via klappy/oddkit#125.

Both bugs caught during the v0.21.1 regression test sweep.

## [0.21.1] - 2026-04-20

### Fixed

- **Strictly-additive invariant restored in `oddkit_challenge` prereq evaluator** (Cursor Bugbot finding on PR #120 / #121, medium severity). The 0.21.0 implementation called `tokenize(input)` and `tokenize(m[1])` with the default `STOP_WORDS` filter on both the input side and the parse-time vocabulary side. Canon vocab keywords that are also English stop words — notably `from` in source-named's vocabulary — were silently dropped from both `inputStems` and `stemmedTokens`. Inputs like `"I learned this from my colleague"` passed `source-named` pre-refactor (via `\bfrom\b` literal regex match) but failed post-refactor, breaking the strictly-additive invariant claimed in the 0.21.0 CHANGELOG and PR description. Fix: pass `new Set()` (empty stop-words) to both `tokenize()` calls so canon vocab survives and both sides share shape. New regression assertions in canon-tool-envelope.smoke.mjs anchor the fix at item (10) `from`-only source attribution and item (11) the `according to` multi-word case.

- **`BasePrerequisite` collapsed to `BasePrerequisiteCore & PrereqMatchVocab` intersection** (Cursor Bugbot finding on PR #120, low severity). The 0.21.0 implementation defined `interface PrereqMatchVocab` to share shape between `BasePrerequisite` and `ChallengeTypeDef.prerequisiteOverlays[]` (DRY) but then re-listed all five fields in `BasePrerequisite` instead of using `& PrereqMatchVocab`. Fix: split into `interface BasePrerequisiteCore` (the three core fields) and `type BasePrerequisite = BasePrerequisiteCore & PrereqMatchVocab` (the intersection). Future field additions to `PrereqMatchVocab` now propagate automatically.

### Process

- This release exists because the 0.21.0 ship process skipped Bugbot's findings (treating in_progress as non-blocking) and skipped Sonnet 4.6 validator dispatch despite the P1.3.2 ledger explicitly warning against making smoke-only the default. Both findings landed in prod for ~15 minutes before recovery. Documented in P1.3.3 closeout ledger as a process failure to carry forward.

## [0.21.0] - 2026-04-20

### Changed

- **`oddkit_challenge` prerequisite evaluation migrated from regex-per-check to stemmed set intersection** (per PRD D5 from P1.3.2 — split-by-fit). Each prereq now evaluates via `Array.from(prereq.stemmedTokens).some(s => inputStems.has(s))` over a Set computed once at canon-fetch time, with `tokenize(input)` hoisted out of the per-prereq loop. **Strictly additive**: every input that matched the prior regex still matches, plus stemmed variations now do too — `problems identified` satisfies `evidence-cited` (stems `problem` + `identif`), `considered alternatives` satisfies `alternatives-considered` (stems `consid` + `altern`), `acknowledged the risks` satisfies `risk-acknowledged` (stems `acknowledg` + `risk`). The four structural side-tests (URL / numeric / proper-noun / citation) preserved verbatim from the pre-refactor evaluator because they cover cases the keyword vocabulary cannot — `source-named` inputs like `"here's the URL: https://..."` have no stemmed overlap with the vocab `per / according to / from / source: / who said / where i read` but the URL structural test catches them. The conservative no-keyword-no-flag fallback (pass on `input.trim().length >= 20`) also preserved. Same matcher gate shipped in 0.20.0.

- **`oddkit_challenge` type-detection BM25 index cache removed** (per PRD D9 from P1.3.2 — don't cache microsecond derivations). `cachedChallengeTypeIndex` and `cachedChallengeTypeIndexKnowledgeBaseUrl` module-level fields deleted; `getOrBuildChallengeTypeIndex` function deleted; `cleanup_storage` resets deleted; the call site in `runChallengeAction` rebuilds the BM25 index inline per request via `buildBM25Index(types.map(t => ({id: t.slug, text: t.detectionText})), vocab.stopWords)`. Same pattern gate shipped in 0.20.0. Removes module-level cache state, URL-keyed invalidation logic, cleanup_storage wiring, and drift risk when source data changes — the four hidden costs enumerated in the new canon principle. Parse-product caches (`cachedChallengeTypes`, `cachedBasePrerequisites`, `cachedNormativeVocabulary`, `cachedStakesCalibration`) remain — those are actual parse work.

### Added

- **New canon principle:** `klappy://canon/principles/cache-fetches-and-parses` (klappy.dev#125, merged `3726073`). Graduates the "cache fetches and parses, not microsecond derivations" pattern to canon as a tier-2 principle after its third deciding-argument recurrence across the tool sweep: 0.18.0 encode parse-product caching (implicit), 0.20.0 gate D9 (first explicit), 0.21.0 challenge `cachedChallengeTypeIndex` removal (second explicit). Names the two halves of the principle, enumerates the four-cost plumbing tax, and anchors the threshold to current corpus sizes (6–9 challenge types, 4 gate transitions, 8 base prereqs).

- **New shared interface `PrereqMatchVocab`** in `workers/src/orchestrate.ts` capturing `stemmedTokens: Set<string>` plus four boolean structural-test flags (`hasURLCheck`, `hasNumericCheck`, `hasProperNounCheck`, `hasCitationCheck`). Mixed into both `BasePrerequisite` and the inline type on `ChallengeTypeDef.prerequisiteOverlays[]` to keep per-type and base-prereq structs in sync. Populated by the new `parseCheckColumn(check: string)` helper at canon-fetch time in both `discoverChallengeTypes` and `fetchBasePrerequisites`.

### Known limitations

- Same as 0.20.0 — Porter-style stemmer does not reverse consonant gemination (`shipping` → `shipp`, not `ship`); affected vocabulary is fixed at canon tier per `klappy.dev#122` precedent. `getIndex` strict-mode (`skipBaselineFallback`) still pending across encode/challenge/gate (carry-forward O-open P2).

## [0.20.0] - 2026-04-20

### Added

- **`governance_source` on `oddkit_gate` envelope** — Gate response `result` now declares which tier served its governance vocabulary: `"knowledge_base"` (both `odd/gate/transitions.md` and `odd/gate/prerequisites.md` parsed from canon) or `"minimal"` (one or both files unreachable; hardcoded vocabulary snapshot used). Strict aggregation rule per P1.3.1 precedent: any helper falling through to minimal makes the aggregate `"minimal"`. Two-tier cascade today — `workers/baseline/` is not yet shipped, and `odd/gate/` is explicitly canon-only per `klappy://canon/constraints/core-governance-baseline` §What-Ships-in-Baseline.

- **`governance_uris` (plural array of 2) on `oddkit_gate` envelope** — Gate reads two peer governance documents (`odd/gate/transitions`, `odd/gate/prerequisites`); the envelope surfaces both URIs in alphabetical order by path-tail. **This is an intentional shape divergence from `oddkit_encode`'s singular `governance_uri`** — encode's encoding-type docs sit under a single canonical umbrella, but gate's two files are peers in a foreign-key relation (transitions references prereq ids defined in prerequisites). Same divergence rationale as `oddkit_challenge` in 0.19.0; gate's array is structurally symmetric because both entries point to peer single files. Consumers that prefer a singular anchor can read `governance_uris[0]` — alphabetical ordering makes this stable.

- **`debug.knowledge_base_url` echo on `oddkit_gate` envelope** — Gate now echoes the caller's `knowledge_base_url` override in the debug envelope, matching encode (0.18.0) and challenge (0.19.0).

- **Two new canon files define gate's governance:** `odd/gate/transitions.md` (four transition keys, from/to endpoints, prerequisite id mappings, BM25 detection terms) and `odd/gate/prerequisites.md` (eight prerequisite ids with check vocabularies and gap messages). Canon-first contract: both files merged to klappy.dev main before this release (klappy/klappy.dev#120).

### Changed

- **`oddkit_gate` transition detection now uses BM25 stemmed matching over canon-supplied vocabulary** (replaces the prior literal word-boundary regex cascade). This is **strictly additive**: every input that matched the prior regex still matches, plus stemmed variations now match too. `deploying`, `released`, `started building`, `building`, and `reconsidering` now match their canonical transitions via stemming. The Porter-style stemmer does not currently reverse consonant gemination (`shipping` → `shipp`, not `ship`), so the small number of geminating verbs gate cares about (`ship`, `step back`) have their inflected forms listed explicitly in `odd/gate/transitions.md` rather than relying on the stemmer. Priority resolution between competing transitions uses BM25 scoring (specific phrase beats bare word — `ready to build` outscores bare `ready` via 2-term-vs-1-term match) rather than the prior fragile regex-cascade order. Row order in `odd/gate/transitions.md` remains as deterministic tiebreaker for genuine ties.

- **`oddkit_gate` prerequisite evaluation now uses stemmed set intersection** (not BM25). Each prereq evaluates independently: pass if any stemmed input token matches any stemmed check term; fail otherwise. This is fit-to-problem — prereqs return gap-or-not in isolation, not a ranking. Avoids BM25's IDF-negative pathology on the small 8-prereq corpus where common vocabulary across prereqs (words like `goal`, `done`, `constraint`) would flip `log((N-df+0.5)/(df+0.5))` negative and produce score-zero contributions on valid matches. Stemming consequence for prereqs: `problems identified` satisfies `problem_defined`, `constraints addressed` satisfies `constraints_satisfied`, `deployed it` satisfies `dod_met`.

- **`oddkit_gate` matching is uniform across tiers.** The `knowledge_base` tier reads vocabulary from canon; the `minimal` tier uses a hardcoded vocabulary snapshot whose content mirrors the pre-0.20.0 regex alternations flattened to comma-separated phrases and words. Both tiers run the same BM25-for-transitions / set-intersection-for-prereqs matchers. The difference between tiers is edit-ability (canon is editable without deploy; minimal is locked to the deployed worker version), not capability. Stemming works in both tiers.

- **`runGateAction` now reads transitions and prerequisites from canon at runtime** via `fetchGateTransitions` and `fetchGatePrerequisites` helpers, replacing the prior hardcoded three-arm if/else over transition tuples and the hardcoded `checkPatterns` regex map. `MINIMAL_TRANSITIONS` and `MINIMAL_PREREQUISITES` module-level constants hold the fallback-tier vocabulary.

- **`result.prerequisites.met` format change (minor):** previously returned prereq description strings (e.g. `"Problem statement is clearly defined"`); now returns prereq ids (e.g. `"problem_defined"`). `result.prerequisites.unmet` now returns the canon-supplied gap messages (e.g. `"Problem statement not defined — the goal or issue being solved is unclear"`) which are more informative than the prior descriptions. Callers doing string-matching on these arrays should update their expectations.

### Fixed

- (none specific to this release)

### Known limitations

- **Stemmer does not handle consonant gemination.** The Porter-style stemmer in `workers/src/bm25.ts` drops common suffixes (`-ing`, `-ed`, etc.) but does not reverse doubled-consonant gemination — `shipping` stems to `shipp` rather than `ship`, `stepped` stems to `stepp` rather than `step`. Gate works around this by listing the handful of geminating inflected forms explicitly in `odd/gate/transitions.md` rather than relying on the stemmer. Non-geminating verbs (`deploy`, `build`, `start`, `reconsider`, etc.) continue to match their inflections via the stemmer alone. Same limitation applies to challenge and any future stemmed-matching tool; a proper Porter stemmer upgrade is tracked as a sweep follow-up.

- **`getIndex` strict-mode (`skipBaselineFallback`) still inherited from 0.18.0 and 0.19.0.** Same limitation documented in prior entries. No tool in the sweep has exercised the code path non-trivially yet; tracked as a P1.3.x follow-up.

- **`workers/baseline/` build pipeline still not shipped.** Two-tier cascade (`"knowledge_base" | "minimal"`) remains the operational envelope enum for gate; `"bundled"` stays out of the enum until the pipeline ships.

- **`oddkit_challenge`'s `evaluatePrerequisiteCheck` is still regex-based.** Migration to stemmed set intersection (same matcher as gate's prereqs per this release's D5) is on the sweep trajectory for challenge's next revisit, bundled with a review of `cachedChallengeTypeIndex` under the "don't cache microsecond derivations" principle applied to gate in this release.

## [0.19.0] - 2026-04-20

### Added

- **`governance_source` on `oddkit_challenge` envelope** — Challenge response `result` now declares which tier served its governance vocabulary: `"knowledge_base"` (all four governance surfaces parsed from canon) or `"minimal"` (one or more surfaces fell through to hardcoded defaults). Strict aggregation rule: any helper falling through to minimal makes the aggregate `"minimal"`. Two-tier cascade today, not three — `workers/baseline/` is not yet shipped (the bundled tier from `canon/constraints/core-governance-baseline` is a contract aspiration, not in-repo code). When the bundled tier ships later, the union expands additively to include `"bundled"` without breaking consumers.

- **`governance_uris` (plural array) on `oddkit_challenge` envelope** — Challenge reads four peer governance documents (`odd/challenge/base-prerequisites`, `odd/challenge-types/`, `odd/challenge/normative-vocabulary`, `odd/challenge/stakes-calibration`); the envelope now surfaces all four URIs in alphabetical order by path-tail. **This is an intentional shape divergence from `oddkit_encode`'s singular `governance_uri`** — encode's encoding-type docs sit under a single canonical umbrella (`canon/definitions/dolcheo-vocabulary`), but challenge's four files are peers with no governing hierarchy, so a single anchor would misrepresent where `base-prerequisites` and `normative-vocabulary` live. Consumers reading both tools must handle both field names. A consumer that prefers a singular anchor can read `governance_uris[0]` — alphabetical ordering makes this stable.

- **`debug.knowledge_base_url` on `oddkit_challenge` envelope** — Challenge now echoes the caller's `knowledge_base_url` override in the debug envelope, matching encode's pattern from 0.18.0. Helps callers verify their override was threaded through, especially when pointing at private or custom canon repos.

### Changed

- **`oddkit_challenge` four governance helpers return `{<domainNoun>, source}` tuples** — `discoverChallengeTypes` → `{types, source}`, `fetchBasePrerequisites` → `{prerequisites, source}`, `fetchNormativeVocabulary` → `{vocabulary, source}`, `fetchStakesCalibration` → `{calibration, source}`. Per-helper domain-noun field names preserve readability at the call site; the `source` flag feeds the aggregate envelope signal. Internal refactor; no input-shape change for callers.

### Fixed

- **0.17.0 release note correction: `governance_source` on challenge.** The 0.17.0 entry for "`governance_source` on refactored tool envelopes" claimed challenge, encode, and telemetry_policy all declared the tier signal. In practice only telemetry_policy did at that HEAD. 0.18.0 retrofitted encode. This release retrofits challenge and closes the last gap in the original 0.17.0 overstatement.

### Known limitations

- **Challenge does not yet implement strict-mode at the index layer** — Same limitation documented in 0.18.0 for encode, inherited through the shared `KnowledgeBaseFetcher.getIndex` merge behavior. Passing `knowledge_base_url` to `oddkit_challenge` echoes the override in `debug.knowledge_base_url` and honors canon overrides when the target repo has challenge-type docs, but `getIndex` merges baseline entries by design (`arbitrateEntries`: canon overrides baseline, baseline is the floor). A custom `knowledge_base_url` pointing at a repo without challenge docs will still return `governance_source: "knowledge_base"` via the default baseline index rather than falling through to `"minimal"`. Strict-mode on `getIndex` remains a tracked follow-up for the P1.3 sweep.

## [0.18.0] - 2026-04-19

### Added

- **DOLCHEO batch-prefix input syntax for `oddkit_encode`** — Paragraph-split input now recognizes per-paragraph prefix tags: `[D]` (Decision), `[O]` (Observation closed), `[L]` (Learning), `[C]` (Constraint), `[H]` (Handoff), `[E]` (Encode), and `[O-open]` with optional priority band (`[O-open P1]`, `[O-open P2.1]`). Each tagged paragraph becomes its own artifact in the response array. See `canon/definitions/dolcheo-vocabulary` for the seven-dimension vocabulary. Unprefixed input still works unchanged (back-compat); TSV `LETTER\tTITLE\tBODY` input still works unchanged.

- **`facet` and `priority_band` fields on encoded artifacts** — Artifacts produced from `[O-open ...]` prefixes carry `facet: "open"` and (when provided) `priority_band: "P1"` / `"P2.1"` so the Open-vs-closed distinction per DOLCHEO survives the envelope. Omitted for non-Open artifacts to keep legacy consumer output identical.

- **`governance_source` on `oddkit_encode` envelope** — Encode response `result` now declares which tier served its vocabulary: `"knowledge_base"` (live canon read succeeded, canon-governed encoding-type docs parsed) or `"minimal"` (canon unreachable, six-letter DOLCHEO fallback in effect). Two-tier cascade, not three — per `canon/constraints/core-governance-baseline`, encoding-types are canon-only (not in the required-baseline manifest), so there is no `"bundled"` middle tier for this tool. The `governance_uri` field now also points at `klappy://canon/definitions/dolcheo-vocabulary` for callers that want the authoritative source.

### Changed

- **Minimal encoding-types fallback upgraded from 5-letter OLDC+H to 6-letter DOLCHEO** — When canon is unreachable, encode's built-in fallback now includes `E` (Encode) in addition to the original D/O/L/C/H. Open remains a facet of O per canon (surfaced via the prefix parser), not a seventh letter.

- **`oddkit_encode` discovery dedups by letter** — Canon now contains separate per-type docs for closed Observation (`odd/encoding-types/observation.md`) and Open (`odd/encoding-types/open.md`), both claiming letter `O`. Discovery keeps the first and skips duplicates so the letter registry stays single-character-per-entry.

- **`oddkit_encode` tool description rewritten** — Now references DOLCHEO, lists the seven dimensions, and documents the batch-prefix syntax.

### Fixed

- **0.17.0 release note correction: `governance_source` on encode and challenge.** The 0.17.0 entry for "`governance_source` on refactored tool envelopes" claimed challenge, encode, and telemetry_policy all declared the tier signal. In practice only telemetry_policy did at HEAD — challenge and encode's envelopes were silent. This release retrofits encode's envelope to declare it. Challenge remains to be fixed in the P1.3 sweep.

### Known limitations

- **Encode does not yet implement strict-mode at the index layer.** Passing `knowledge_base_url` to `oddkit_encode` echoes the override in `debug.knowledge_base_url` and honors canon overrides when the target repo has encoding-type docs, but `getIndex` merges baseline entries by design (`arbitrateEntries`: canon overrides baseline, baseline is the floor). A custom `knowledge_base_url` pointing at a repo without encoding-type docs will still return `governance_source: "knowledge_base"` via the default baseline rather than falling through to `"minimal"`. Telemetry_policy's strict mode (via `getFile`'s `skipBaselineFallback` option) is not yet available on `getIndex`. Tracked for the P1.3 sweep.

## [0.17.0] - 2026-04-19

### Added

- **`oddkit_time` — stateless time utility (E0008.2)** — New standalone tool with three modes: no params returns current UTC; one timestamp returns elapsed since reference; two timestamps return delta. Resolves the "time-blindness" axiom violation where the LLM had to infer elapsed time from context clues. Pass the prior response's `server_time` as `reference` to get both current time and elapsed-since-last-turn in one call.

- **`server_time` in every response envelope (E0008.2)** — Every oddkit tool response now carries a `server_time` ISO 8601 string in the top-level envelope. Gives every LLM turn a ground-truth clock reading as a side effect of normal tool use — no extra call required.

- **X-ray tracing on tool responses (E0008.1)** — `debug.trace` now lists every resolution span (sha lookup, file fetch, zip extract, action timing) with per-span duration and source (`github`, `r2`, `build`, etc.). Gives transparent latency attribution without separate observability tooling.

- **Governance-driven `oddkit_challenge` (E0008)** — Challenge now reads its vocabulary (claim types, mode rules, stop words, prohibitions) from canon at runtime instead of hardcoded constants. Uses BM25 + stemming over governance documents for detection. Canon changes propagate without code redeploy.

- **Governance-driven `oddkit_encode`** — Encode's type recognition now reads from canon's encoding-type vocabulary at runtime. Honors the context-vs-input governance distinction (negative/positive criteria scope to artifact body, not context).

- **Governance-driven `telemetry_policy` (canary)** — `self_report_headers` section now built from canon at runtime via three-tier resolution: live canon → bundled baseline → fail-loud error envelope. Reference pattern for the remaining prompt-over-code refactor arc.

- **`governance_source` on refactored tool envelopes** — Challenge, encode, and telemetry_policy responses now declare which tier served their governance vocabulary: `"knowledge_base"` (live canon read), `"bundled"` (baseline fallback), or `"minimal"` (hardcoded last resort).

- **`?consumer=yourname` query parameter** — Highest-priority consumer identification method, platform-agnostic. Works where headers don't (Lovable edge functions, Claude.ai connectors, etc.). Unidentified consumers now receive a one-time nudge in responses to add the parameter.

- **Governance anti-pattern audit** — Full code audit of all 11 oddkit tools against the vodka anti-pattern (canon defines vocabulary; code must not hardcode interpretation). Documented at `docs/oddkit/audit/governance-anti-pattern-sweep-2026-04-17.md`. Priority-ordered sweep list for remaining tools.

### Changed

- **`canon_url` → `knowledge_base_url` (user-facing contract rename)** — The override argument accepted by `search`, `get`, `catalog`, `challenge`, `encode`, and other tools renamed from `canon_url` to `knowledge_base_url`. Semantic: the URL points to any knowledge base, not only the klappy.dev canon repo. **BREAKING:** legacy `canon_url` accept stripped from `parseToolCall`. Callers must use the new name. The telemetry `blob6` field now carries `knowledge_base_url` as the rendered field name.

- **Internal rename: `canon*` → `knowledge_base*`** — `canonUrl`, `ZipBaselineFetcher`, `BASELINE_URL`, and related internal symbols renamed to match the user-facing contract. Filename `workers/src/zip-baseline-fetcher.ts` retained for diff minimality.

- **Challenge mode enum accepts all nine modes** — Previously only three of the nine execution/writing-canon modes were accepted; the remaining six returned schema errors. All nine now parse correctly.

### Fixed

- **Branch ref extraction with slashes** — Branch names containing slashes (e.g. `feat/thing`) now survive `extractBranchRef` and `getZipUrl` intact. Previously lost the segment after the slash.

- **Isolate cross-contamination in BM25 index cache** — Cached BM25 index now guarded by `canonUrl` key. Previously a second request with a different canon override could receive the first caller's index.

- **Suppression envelope completeness** — `SUPPRESSED` challenge responses now include the `governance` field alongside the suppression reason, matching the non-suppressed response shape.

- **First-reframing surfacing** — `first_1` reframings now return a single reframing total, not a singleton wrapped in an array.

- **Articles type annotation** — Missing `title` field added to the articles type (unblocks a silent TypeScript narrowing regression).

- **Encode context-vs-input scoping** — Keyword-pattern criteria in encode now scope to `artifact.body` rather than the whole context, preventing user context from corrupting positive/negative criterion checks.

- **Local `kb://` compound file suffix resolution** — `findDocPath` now scans for files with compound extensions (`.surface.md`, `.full.md`) on the local/CLI path, matching the worker path's index-lookup behavior.

- **Challenge BM25 governance fixes** — Stop words moved from hardcoded constant into governance. Empty middle cells preserved in the governance table parser. Mode casing normalized and sort directive regex ordered by length. Claim-type alias restored in response envelope.

- **Time utility edge cases** — `compare` without `reference` now validates. `-r` flag collision and numeric epoch string parsing resolved. Standalone tools excluded from the orchestrator action enum.

- **Index source telemetry** — Corrected `checkForChanges` tautology and `invalidateCache` coverage. Expired file cache entries now evicted before size-cap check. CI preview URL sanitization replaces dots with hyphens.

### Notes

- **Epoch progression since 0.16.0:** E0008 (governance-driven challenge), E0008.1 (x-ray tracing + KV elimination), E0008.2 (`server_time` + `oddkit_time`), E0008.3 (validation as fourth epistemic mode; canon-side — no tool changes).

- **Prompt-over-code refactor arc opened.** `oddkit_challenge`, `oddkit_encode`, and `telemetry_policy` now fetch their governance vocabulary from canon at runtime. Remaining tools (`oddkit_gate`, `oddkit_preflight`, `oddkit_validate`, `oddkit_orient`, `oddkit_search`, `oddkit_catalog`) queued for the same refactor template.

## [0.16.0] - 2026-04-03

### Added

- **Catalog temporal discovery** — New `sort_by`, `limit`, and `filter_epoch` parameters on `oddkit_catalog`. `sort_by: "date"` returns articles sorted newest-first with full frontmatter metadata. `filter_epoch` provides server-side deterministic filtering. Addresses the "what's new?" discoverability gap — no new tools added, extending catalog as the discovery tool.

- **Full frontmatter indexing** — `IndexEntry` now stores complete parsed frontmatter on every document (previously cherry-picked 6 fields). Generic YAML parser replaces field-specific regex extraction. Enables `date`, `epoch`, `audience`, `tier`, `stability`, and all custom fields in metadata responses.

- **Proactive tool descriptions (E0007)** — Every tool description now includes a proactive usage hint: orient ("call at every context shift"), search ("search before claiming"), challenge ("challenge before encoding"), gate ("gate at every implicit transition"), validate ("validate before claiming done"), preflight ("preflight before every execution task").

- **Encode persistence warning** — Encode responses now include `persist_required: true` and `next_action` instructing the caller to save the output. Addresses the silent data loss pattern where operators assumed encode persisted.

- **Orient OLDC+H instruction** — Orient responses now include a proactive posture instruction: "Track OLDC+H continuously throughout this session." Includes artifact provenance gate: capture what happened (journal), what changed (summary), and what version — at every milestone, before every review, and before finalizing.

- **Validate artifact provenance gate** — When completion claims mention finalizing work (commit, merge, publish, submit, deliver, etc.), validate checks for session capture (OLDC+H), change summary, and version tracking. Domain-agnostic — applies to code, writing, planning, or any domain.

### Fixed

- **Branch ref extraction from canon_url** — `getZipUrl` was discarding the branch name from `raw.githubusercontent.com` URLs, always fetching `main.zip`. Branch-specific articles never appeared in canon_url overrides. Now correctly extracts `parts[2]` as the branch ref.

- **Cache key mismatch for branch refs** — `getLatestCommitSha` defaulted to `"main"` even when the ZIP was fetched from a branch. Cache key used main's SHA while content had branch content. SHA lookup now respects the extracted branch ref.

- **Unified YAML parser** — Two separate frontmatter parsers (`parseFrontmatter` at index time and `parseFullFrontmatter` at request time) could produce inconsistent metadata. Consolidated into a single shared parser in `zip-baseline-fetcher.ts`.

- **Numeric date sort safety** — `parseFrontmatter` converts bare numeric values to `Number` (e.g., `date: 2026` becomes `2026`). Catalog date sort now uses `String()` coercion to prevent `TypeError` on `localeCompare`.

- **Epoch filter strict equality** — `filter_epoch` comparison now handles numeric frontmatter values correctly.

- **SSE test timeout** — CI test for SSE content-type waited 30 seconds for a long-lived stream to close. Reduced to 5 seconds — only the headers are needed.

### Changed

- **Index version bumped to 2.3** — Reflects full frontmatter indexing, branch ref fix, and cache invalidation.

## [0.15.1] - 2026-03-14

### Added

- **Frontmatter-driven indexing for supplementary repos** — `search` with `canon_url` now indexes all `.md` files that declare a `title` in YAML frontmatter, regardless of directory structure. Satisfies `meaning-must-not-depend-on-path` — inclusion is determined by what the file declares about itself, not where it lives. Baseline repo retains directory whitelist as defense-in-depth.

- **`exposure: noindex` frontmatter opt-out** — Any `.md` file with `exposure: noindex` in its frontmatter is excluded from the search index, for both baseline and supplementary repos.

- **Section-level extraction on `get`** — New `section` parameter on `get` action (both unified `oddkit` tool and `oddkit_get` individual tool) extracts content between `## {section}` headers. Returns only the requested slice to prevent context overflow on large files. On miss, returns available `##` headers so the agent can self-correct.

### Fixed

- **`kb://` URI resolution in `get` tool** — Non-`klappy://` URIs (e.g. `kb://` from canon override repos) now resolve correctly via index lookup. Worker `runGet` consults the baseline index to find the actual file path (handles `.surface.md`, `.full.md`, etc.) with scheme-stripping fallback. Node `uriToPath` recognizes `kb://` as a valid scheme with the same path-traversal protections as `klappy://`.

### Changed

- **Index version bumped to 1.4.0** — Reflects frontmatter-driven inclusion gate and `exposure` field in index pipeline.
- **Supplementary repo URI scheme** — Uses `klappy://` consistently (from frontmatter `uri` when present, falling back to path-derived `klappy://` URI). Repos should declare `uri` in frontmatter for stable identity.

## [0.15.1] - 2026-03-14

### Fixed

- **Local `kb://` handler resolves compound file suffixes** — `findDocPath` in `docFetch.js` now scans for files with compound extensions (`.surface.md`, `.full.md`, etc.) when the exact `.md` path is not found. Previously, `kb://` URIs returned from search could not be resolved by `get` on the local/CLI path because `uriToPath` always appended `.md`, missing files with non-standard suffixes. The worker path already handled this via index lookup; the local path now uses a directory scan as equivalent fallback.

## [0.14.1] - 2026-02-19

### Fixed

- **MCP session ID missing on tool call responses** — `Mcp-Session-Id` header was only returned on `initialize` responses, not on subsequent `tools/call` or other requests. Claude Code cloud's MCP HTTP client expects session confirmation on every response and hangs indefinitely when it is missing. Now echoes the client's session ID back on all `/mcp` POST responses. (Regression from incomplete v0.10.1 fix which only added the header to `initialize`.)

## [0.13.0] - 2026-02-10

### Added

- **Two-layer MCP tool surface** — Unified `oddkit` orchestrator + individual first-class tools:
  - **Layer 1: `oddkit` orchestrator** — Single entry point with `action` routing and client-side `state` threading for multi-turn workflows. State tracks `phase`, `gates_passed`, `decisions_encoded`, `unresolved`, and `canon_refs`.
  - **Layer 2: Individual tools** — Stateless thin wrappers (`oddkit_orient`, `oddkit_challenge`, `oddkit_gate`, `oddkit_encode`, `oddkit_search`, `oddkit_get`, `oddkit_catalog`, `oddkit_validate`, `oddkit_preflight`, `oddkit_version`, `oddkit_invalidate_cache`) for targeted use when a model knows exactly what action it needs.

- **BM25 search** — Full-text search over canon/baseline documents replacing the broken librarian:
  - Porter-style stemming, stop word removal, standard BM25 scoring (k1=1.2, b=0.75)
  - Indexes frontmatter tags, titles, file path segments, and content excerpts
  - Available as `oddkit_search` tool and `search` action on the orchestrator
  - New files: `workers/src/bm25.ts` (Worker), `src/search/bm25.js` (Node)

- **Consistent response envelope** — All actions return `OddkitEnvelope`: `{ action, result, state?, assistant_text, debug? }`

- **New tools**: `oddkit_search` (replaces librarian), `oddkit_get` (fetch doc by URI), `oddkit_version` (canon target info), `oddkit_preflight` (pre-implementation check)

### Changed

- **Parameter standardization** — Both Node and Worker servers now use `canon_url` consistently (replaces `baseline`/`repo_root` from Node server)
- **`workers/src/orchestrate.ts` rewritten** — Unified handler architecture with `handleUnifiedAction()` routing to all action handlers, lazy BM25 index caching, and state management
- **Tool registration cleanup** — Both `src/mcp/server.js` and `workers/src/index.ts` use the same two-layer pattern with shared action-to-name mapping

### Removed

- **`oddkit_orchestrate`** — Replaced by the unified `oddkit` tool
- **`oddkit_librarian`** — Replaced by `oddkit_search` with BM25 ranking
- **`oddkit_policy_get`** — Replaced by `oddkit_get`
- **`oddkit_policy_version`** — Replaced by `oddkit_version`

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
