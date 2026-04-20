#!/usr/bin/env node
/**
 * Live smoke test for knowledge-base-driven MCP tool envelope contracts.
 *
 * Exercises the actual MCP endpoint (preview or prod) and verifies that
 * every canon-driven tool returns the full envelope shape:
 *
 *   { action, result, server_time, assistant_text, debug, ... }
 *
 * AND that knowledge-base-driven tools surface `governance_source` inside `result` with one of: knowledge_base | bundled | minimal.
 *
 * Why this exists: parser tests (workers/test/governance-parser.test.mjs)
 * exercise parser logic in isolation. They passed for the telemetry_policy
 * canary, but the canary shipped with a broken envelope and silent
 * knowledge_base_url fallback because no test invoked the MCP tool end-to-end.
 * Parser tests cannot catch the tool's response contract — only live smoke
 * against the MCP endpoint can. This test also verifies the strict-override
 * contract: when knowledge_base_url points at a repo lacking the file, the
 * response must surface governance_source: 'minimal', not silently substitute
 * from the default knowledge base.
 *
 * Usage:
 *   node workers/test/canon-tool-envelope.smoke.mjs
 *   ODDKIT_URL=https://preview-xxx.oddkit.klappy.dev/mcp node ...
 *
 * Exit 0 on all pass, 1 on any failure.
 */

const ODDKIT_URL = process.env.ODDKIT_URL || "https://oddkit.klappy.dev/mcp";

let passed = 0;
let failed = 0;

function ok(label, cond, hint = "") {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}${hint ? ` — ${hint}` : ""}`);
    failed++;
  }
}

async function callTool(name, args = {}) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const res = await fetch(ODDKIT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "x-oddkit-client": "envelope-smoke-test",
    },
    body,
  });
  const text = await res.text();
  // SSE format: `event: message\ndata: {...}\n\n`
  const match = text.match(/data: (\{[\s\S]*\})/);
  if (!match) throw new Error(`No data payload from ${name}: ${text.slice(0, 300)}`);
  const envelope = JSON.parse(match[1]);
  const inner = JSON.parse(envelope.result.content[0].text);
  return inner;
}

function expectFullEnvelope(toolName, inner) {
  console.log(`\n─── Envelope shape: ${toolName} ───`);
  ok(`${toolName}: has 'action'`, typeof inner.action === "string");
  ok(`${toolName}: has 'result'`, typeof inner.result === "object" && inner.result !== null);
  ok(`${toolName}: has 'server_time' (ISO 8601)`,
    typeof inner.server_time === "string" && /^\d{4}-\d{2}-\d{2}T/.test(inner.server_time),
    `got: ${inner.server_time}`);
  ok(`${toolName}: has 'assistant_text'`, typeof inner.assistant_text === "string" && inner.assistant_text.length > 0);
  ok(`${toolName}: has 'debug'`, typeof inner.debug === "object" && inner.debug !== null);
  ok(`${toolName}: debug.duration_ms is a number`, typeof inner.debug?.duration_ms === "number");
}

function expectGovernanceSource(toolName, inner, expectedTier) {
  console.log(`\n─── Governance source: ${toolName} ───`);
  const source = inner.result?.governance_source;
  ok(`${toolName}: result.governance_source present`, typeof source === "string", `got: ${source}`);
  ok(`${toolName}: result.governance_source is one of knowledge_base|bundled|minimal`,
    ["knowledge_base", "bundled", "minimal"].includes(source),
    `got: ${source}`);
  if (expectedTier) {
    ok(`${toolName}: result.governance_source == "${expectedTier}"`,
      source === expectedTier,
      `got: ${source}`);
  }
}

async function run() {
  console.log(`Target: ${ODDKIT_URL}\n`);

  // Tool 1: oddkit_time — non-canon-driven baseline for envelope convention
  const timeResult = await callTool("oddkit_time");
  expectFullEnvelope("oddkit_time", timeResult);

  // Tool 2: telemetry_policy — canon-driven, should have full envelope + governance_source
  const policyDefault = await callTool("telemetry_policy");
  expectFullEnvelope("telemetry_policy (default knowledge_base)", policyDefault);
  expectGovernanceSource("telemetry_policy (default knowledge_base)", policyDefault, "knowledge_base");

  // Tool 3: telemetry_policy with knowledge_base_url override pointing at a repo
  // that doesn't have the governance file — should fall back to minimal.
  // This verifies the strict-override contract: when knowledge_base_url is set,
  // the bundled fallback is suppressed so a missing file surfaces as "minimal".
  console.log(`\n─── knowledge_base_url override: telemetry_policy ───`);
  const policyOverride = await callTool("telemetry_policy", {
    knowledge_base_url: "https://github.com/torvalds/linux",
  });
  expectFullEnvelope("telemetry_policy (knowledge_base_url override)", policyOverride);
  ok(
    "telemetry_policy: knowledge_base_url override falls back to minimal when file missing (strict mode)",
    policyOverride.result?.governance_source === "minimal",
    `got: ${policyOverride.result?.governance_source}`,
  );
  ok(
    "telemetry_policy: minimal fallback still returns 8 headers",
    Object.keys(policyOverride.result?.self_report_headers ?? {}).length === 8,
    `got: ${Object.keys(policyOverride.result?.self_report_headers ?? {}).length}`,
  );
  ok(
    "telemetry_policy: debug.knowledge_base_url echoes the override",
    policyOverride.debug?.knowledge_base_url === "https://github.com/torvalds/linux",
    `got: ${policyOverride.debug?.knowledge_base_url}`,
  );

  // Tool 4: telemetry_public — should have full envelope (no governance_source)
  console.log("\n─── Testing: telemetry_public ───");
  const telemetryPublicResult = await callTool("telemetry_public", {
    sql: "SELECT 1 AS probe FROM oddkit_telemetry WHERE timestamp > NOW() - INTERVAL '1' HOUR LIMIT 1"
  });
  expectFullEnvelope("telemetry_public", telemetryPublicResult);

  // Tool 5: oddkit_encode — canon-driven, DOLCHEO-aware. Full envelope +
  // governance_source + DOLCHEO prefix-tag batch mode + Open facet + back-
  // compat for unprefixed input.
  console.log(`\n─── oddkit_encode: envelope + governance_source ───`);
  const encodeSingle = await callTool("oddkit_encode", {
    input: "decided to ship two-tier cascade because encoding-types are canon-only per the baseline contract",
  });
  expectFullEnvelope("oddkit_encode (single unprefixed)", encodeSingle);
  expectGovernanceSource("oddkit_encode (single unprefixed, default KB)", encodeSingle, "knowledge_base");
  ok(
    "oddkit_encode: result.governance_uri points at DOLCHEO canon",
    encodeSingle.result?.governance_uri === "klappy://canon/definitions/dolcheo-vocabulary",
    `got: ${encodeSingle.result?.governance_uri}`,
  );
  ok(
    "oddkit_encode: result.artifacts is an array",
    Array.isArray(encodeSingle.result?.artifacts),
    `got: ${typeof encodeSingle.result?.artifacts}`,
  );
  ok(
    "oddkit_encode: single unprefixed input returns at least one artifact (backward compat)",
    (encodeSingle.result?.artifacts?.length ?? 0) >= 1,
    `got length: ${encodeSingle.result?.artifacts?.length}`,
  );

  console.log(`\n─── oddkit_encode: DOLCHEO batch-prefix parsing ───`);
  const encodeBatch = await callTool("oddkit_encode", {
    input: "[D] picked two-tier cascade because contract classifies encoding-types as canon-only\n\n[O] telemetry_policy canary already declares governance_source\n\n[L] recency of handoff ≠ authority over governing contract",
  });
  expectFullEnvelope("oddkit_encode (batch prefix)", encodeBatch);
  ok(
    "oddkit_encode: batch of 3 prefixed paragraphs returns exactly 3 artifacts",
    encodeBatch.result?.artifacts?.length === 3,
    `got length: ${encodeBatch.result?.artifacts?.length}`,
  );
  const batchTypes = (encodeBatch.result?.artifacts ?? []).map((a) => a.type);
  ok(
    "oddkit_encode: artifact types match prefix order [D,O,L]",
    JSON.stringify(batchTypes) === JSON.stringify(["D", "O", "L"]),
    `got: ${JSON.stringify(batchTypes)}`,
  );

  console.log(`\n─── oddkit_encode: Open facet + priority band ───`);
  const encodeOpen = await callTool("oddkit_encode", {
    input: "[O-open P1] retrofit encode envelope to declare governance_source\n\n[O-open P2.1] correct handoff Tier 2/3 wording in follow-up PR",
  });
  expectFullEnvelope("oddkit_encode (O-open with bands)", encodeOpen);
  const openArtifacts = encodeOpen.result?.artifacts ?? [];
  ok(
    "oddkit_encode: [O-open P1] sets facet='open' and priority_band='P1'",
    openArtifacts[0]?.facet === "open" && openArtifacts[0]?.priority_band === "P1",
    `got: facet=${openArtifacts[0]?.facet} band=${openArtifacts[0]?.priority_band}`,
  );
  ok(
    "oddkit_encode: sub-band [O-open P2.1] is preserved",
    openArtifacts[1]?.priority_band === "P2.1",
    `got: ${openArtifacts[1]?.priority_band}`,
  );
  ok(
    "oddkit_encode: O-open artifacts still use letter 'O' (facet, not separate letter)",
    openArtifacts.every((a) => a.type === "O"),
    `got: ${openArtifacts.map((a) => a.type).join(",")}`,
  );

  console.log(`\n─── oddkit_encode: knowledge_base_url override ───`);
  const encodeOverride = await callTool("oddkit_encode", {
    input: "[D] verify override is threaded through to debug envelope",
    knowledge_base_url: "https://github.com/torvalds/linux",
  });
  expectFullEnvelope("oddkit_encode (knowledge_base_url override)", encodeOverride);
  ok(
    "oddkit_encode: debug.knowledge_base_url echoes the override",
    encodeOverride.debug?.knowledge_base_url === "https://github.com/torvalds/linux",
    `got: ${encodeOverride.debug?.knowledge_base_url}`,
  );
  // NOTE: encode does not yet implement strict-mode at the index layer.
  // getIndex merges canon + baseline entries by design (arbitrateEntries:
  // canon overrides baseline, baseline is the floor), so an override URL
  // without encoding-type docs still returns "knowledge_base" via the
  // default baseline. Strict-mode on getIndex is an explicit follow-up for
  // the P1.3 sweep — asserting "minimal" here would require that refactor.
  // For now, we verify the tier value is present and valid.
  ok(
    "oddkit_encode: override returns valid governance_source (either knowledge_base via baseline-merge, or minimal)",
    ["knowledge_base", "minimal"].includes(encodeOverride.result?.governance_source),
    `got: ${encodeOverride.result?.governance_source}`,
  );

  // P1.3.4 D5 regression anchors — stemmed set intersection replaces regex
  // alternation on the encode classifier. These assertions exist because
  // the pre-refactor literal regex path could not match inflections of
  // canon vocab (`deciding` does not match `decided` under `\bdecided\b`),
  // and the P1.3.3 Bug #1 precedent showed that tokenize()'s default
  // stop-word filter silently breaks multi-word canon vocab (`going with`,
  // `committed to`, `must not`). The assertions are numbered (12)–(15) to
  // continue the sequence P1.3.3 established at (10)/(11).
  console.log(`\n─── oddkit_encode: (12) stemmed inflection match (D5 landed) ───`);
  const encodeInflection = await callTool("oddkit_encode", {
    input: "I'm deciding to ship the two-tier cascade",
  });
  expectFullEnvelope("oddkit_encode (inflection match)", encodeInflection);
  const inflectionTypes = (encodeInflection.result?.artifacts ?? []).map((a) => a.type);
  ok(
    "oddkit_encode: (12) `deciding` (inflection of `decided`) classifies as Decision via stem intersection",
    inflectionTypes.includes("D"),
    `got artifact types: ${inflectionTypes.join(",")}`,
  );

  console.log(`\n─── oddkit_encode: (13) stop-word canon vocab survives tokenize (P1.3.3 C-04 ported) ───`);
  const encodeStopWord = await callTool("oddkit_encode", {
    input: "we're going with option B after the review",
  });
  expectFullEnvelope("oddkit_encode (stop-word survival)", encodeStopWord);
  const stopWordTypes = (encodeStopWord.result?.artifacts ?? []).map((a) => a.type);
  ok(
    "oddkit_encode: (13) `going with` (multi-word canon vocab containing stop-word `with`) matches Decision",
    stopWordTypes.includes("D"),
    `got artifact types: ${stopWordTypes.join(",")}`,
  );

  console.log(`\n─── oddkit_encode: (14) multi-type no-break preservation (L1161 design comment) ───`);
  const encodeMultiType = await callTool("oddkit_encode", {
    input: "We must never deploy without tests because we decided this last week",
  });
  expectFullEnvelope("oddkit_encode (multi-type)", encodeMultiType);
  const multiTypeTypes = (encodeMultiType.result?.artifacts ?? []).map((a) => a.type);
  ok(
    "oddkit_encode: (14) paragraph matching both Constraint and Decision emits both artifact types (no-break path)",
    multiTypeTypes.includes("C") && multiTypeTypes.includes("D"),
    `got artifact types: ${multiTypeTypes.join(",")}`,
  );

  console.log(`\n─── oddkit_encode: (15) first-match preservation in batch-untagged path ───`);
  const encodeBatchUntagged = await callTool("oddkit_encode", {
    input: "[D] explicit decision tag on first paragraph\n\nwe must always write tests before we decided on TDD",
  });
  expectFullEnvelope("oddkit_encode (batch first-match)", encodeBatchUntagged);
  const batchArtifacts = encodeBatchUntagged.result?.artifacts ?? [];
  ok(
    "oddkit_encode: (15) batch with tagged + untagged paragraphs emits exactly 2 artifacts (first-match path picks one type per untagged paragraph)",
    batchArtifacts.length === 2,
    `got length: ${batchArtifacts.length}; types: ${batchArtifacts.map((a) => a.type).join(",")}`,
  );

  console.log(`\n─── oddkit_encode: (16) phrase-subset regression anchor (Bugbot PR #126) ───`);
  // Pre-Bugbot-fix the matcher used a flat stemmedTokens: Set<string> where
  // multi-word canon phrases like `committed to` (Decision) and `next step`
  // (Handoff) were flattened into individual stems and each was added as a
  // standalone singleton. Stop-word filtering is disabled by design (P1.3.3
  // C-04), so function-word stems like `to`, `with`, `by`, `up`, `out`
  // became universal match triggers — virtually every English paragraph
  // would fire Decision and Handoff and more. Autofix commit 113ba11
  // adopted a phrase-subset match: a phrase matches only when ALL of its
  // stems appear in the input stem set. Single-stem phrases degenerate to
  // set membership (inflection matching still works); multi-stem phrases
  // require conjunction. The input below contains stems `need`, `to`,
  // `wait`, `until`, `tomorrow`, `for`, `the`, `review` — no Decision
  // phrase has ALL its stems present (`decid` / `decis` / `chose` / `choos`
  // / `select` all absent; `[committ, to]` fails on `committ`; `[go, with]`
  // fails on both), and no Handoff phrase has ALL its stems present
  // (`[next, session]` / `[next, step]` / `[follow, up]` / `[block, by]`
  // / `[wait, on]` all fail on their second stem; `todo` / `continu` /
  // `remain` / `handoff` singletons all absent). A revision that
  // re-flattens the matcher would spuriously fire D and H on this input.
  const encodePhraseSubset = await callTool("oddkit_encode", {
    input: "I need to wait until tomorrow for the review",
  });
  expectFullEnvelope("oddkit_encode (phrase-subset regression)", encodePhraseSubset);
  const phraseSubsetTypes = (encodePhraseSubset.result?.artifacts ?? []).map((a) => a.type);
  ok(
    "oddkit_encode: (16) `to` inside phrasal canon vocab does NOT fire Decision as a standalone trigger",
    !phraseSubsetTypes.includes("D"),
    `got artifact types: ${phraseSubsetTypes.join(",")}`,
  );
  ok(
    "oddkit_encode: (16) `to` inside phrasal canon vocab does NOT fire Handoff as a standalone trigger",
    !phraseSubsetTypes.includes("H"),
    `got artifact types: ${phraseSubsetTypes.join(",")}`,
  );

  // Tool 5: oddkit_challenge — canon-driven, four governance surfaces.
  // Full envelope + governance_source + governance_uris (plural, per PRD D4 —
  // shape diverges from encode by design because challenge reads four peer
  // governance files, not a single hierarchy).
  console.log(`\n─── oddkit_challenge: envelope + governance_source + governance_uris ───`);
  const challengeDefault = await callTool("oddkit_challenge", {
    input: "I think we should ship this refactor today",
    mode: "planning",
  });
  expectFullEnvelope("oddkit_challenge (default knowledge_base)", challengeDefault);
  expectGovernanceSource("oddkit_challenge (default knowledge_base)", challengeDefault, "knowledge_base");
  ok(
    "oddkit_challenge: result.governance_uris is an array of exactly 4 entries",
    Array.isArray(challengeDefault.result?.governance_uris) &&
      challengeDefault.result?.governance_uris.length === 4,
    `got: ${JSON.stringify(challengeDefault.result?.governance_uris)}`,
  );
  const expectedUris = [
    "klappy://odd/challenge/base-prerequisites",
    "klappy://odd/challenge-types",
    "klappy://odd/challenge/normative-vocabulary",
    "klappy://odd/challenge/stakes-calibration",
  ];
  ok(
    "oddkit_challenge: governance_uris matches alphabetical peer set",
    JSON.stringify(challengeDefault.result?.governance_uris) === JSON.stringify(expectedUris),
    `got: ${JSON.stringify(challengeDefault.result?.governance_uris)}`,
  );
  ok(
    "oddkit_challenge: result.governance_uri (singular) is NOT emitted on challenge (divergence from encode by design — PRD D4)",
    challengeDefault.result?.governance_uri === undefined,
    `got: ${challengeDefault.result?.governance_uri}`,
  );

  console.log(`\n─── oddkit_challenge: knowledge_base_url override ───`);
  const challengeOverride = await callTool("oddkit_challenge", {
    input: "testing override threading",
    mode: "planning",
    knowledge_base_url: "https://github.com/torvalds/linux",
  });
  expectFullEnvelope("oddkit_challenge (knowledge_base_url override)", challengeOverride);
  ok(
    "oddkit_challenge: debug.knowledge_base_url echoes the override",
    challengeOverride.debug?.knowledge_base_url === "https://github.com/torvalds/linux",
    `got: ${challengeOverride.debug?.knowledge_base_url}`,
  );
  // Same getIndex merge caveat as encode (PRD §3.5 + Known Limitations):
  // override without challenge docs can still resolve via default baseline
  // merge. Accept either valid enum value.
  ok(
    "oddkit_challenge: override returns valid governance_source enum value",
    ["knowledge_base", "minimal"].includes(challengeOverride.result?.governance_source),
    `got: ${challengeOverride.result?.governance_source}`,
  );

  // 9-mode parse integrity — PR #100 regression guard. stakes-calibration
  // defines 9 modes; every one must return a full envelope with valid
  // governance_source. voice-dump additionally asserts SUPPRESSED status
  // because that branch has its own early-return envelope that must also
  // carry governance_source + governance_uris (see PRD §10 risk register).
  console.log(`\n─── oddkit_challenge: 9-mode parse integrity ───`);
  const modes = [
    "exploration",
    "planning",
    "execution",
    "voice-dump",
    "drafting",
    "peer-review-ready",
    "canon-tier-2",
    "canon-tier-1",
    "published-essay",
  ];
  for (const m of modes) {
    const r = await callTool("oddkit_challenge", {
      input: "sample claim under mode pressure — canon defines the rules",
      mode: m,
    });
    ok(`oddkit_challenge[${m}]: has 'action'`, typeof r.action === "string");
    ok(`oddkit_challenge[${m}]: has 'server_time'`, typeof r.server_time === "string");
    ok(
      `oddkit_challenge[${m}]: governance_source valid`,
      ["knowledge_base", "bundled", "minimal"].includes(r.result?.governance_source),
      `got: ${r.result?.governance_source}`,
    );
    ok(
      `oddkit_challenge[${m}]: governance_uris present and length 4`,
      Array.isArray(r.result?.governance_uris) && r.result?.governance_uris.length === 4,
      `got: ${JSON.stringify(r.result?.governance_uris)}`,
    );
    if (m === "voice-dump") {
      ok(
        `oddkit_challenge[voice-dump]: status === SUPPRESSED (SUPPRESSED branch carries governance fields)`,
        r.result?.status === "SUPPRESSED",
        `got: ${r.result?.status}`,
      );
    } else {
      ok(
        `oddkit_challenge[${m}]: status === CHALLENGED`,
        r.result?.status === "CHALLENGED",
        `got: ${r.result?.status}`,
      );
    }
  }

  // P1.3.3 — stemmed set intersection assertions (challenge prereq evaluator).
  // Per PRD D5 (split-by-fit): prereq evaluation is independent gap-or-not per
  // prereq, not ranked; stemmed Set intersection over canon-quoted vocabulary
  // catches morphological variations the prior regex missed. Strictly additive
  // over the pre-refactor evaluator. Structural side-tests (URL, numeric,
  // proper-noun, citation) preserved. See klappy://canon/principles/cache-fetches-and-parses.
  console.log(`\n─── oddkit_challenge: P1.3.3 stemmed prereq evaluator ───`);

  // Helper: derive the missing-prereq list from a challenge response. The
  // gap-message strings come from canon (base-prerequisites.md and per-type
  // articles); we test by substring on canon-stable phrases.
  const challengeMissing = async (text, mode = "execution") => {
    const r = await callTool("oddkit_challenge", { input: text, mode });
    return r.result?.missing_prerequisites || [];
  };
  const includesGap = (missing, phrase) =>
    missing.some((g) => typeof g === "string" && g.toLowerCase().includes(phrase.toLowerCase()));

  // (1) Stemmed match on inflected base-prereq vocab — `observed` is in canon
  // for evidence-cited; `noticed` and `measured` also. Stemmed Set intersection
  // means inflected forms (e.g. "I'm noticing") all share the stem `notic`.
  const stemmedBaseInputs = [
    "I observed a problem in production today, per the logs at https://example.com/log",
    "I'm noticing an issue per the reports we collected from the field engineers",
    "I read about this case in the article from John Smith yesterday",
  ];
  for (const txt of stemmedBaseInputs) {
    const missing = await challengeMissing(txt);
    ok(
      `oddkit_challenge: P1.3.3 base-prereq evidence-cited passes for stemmed input "${txt.slice(0, 40)}…"`,
      !includesGap(missing, "no evidence cited"),
      `missing: ${JSON.stringify(missing)}`,
    );
  }

  // (2) Stemmed per-type prereq match — proposal type's `alternatives-considered`
  // canon vocab is `alternative, instead, option, considered, rejected`; stemmed
  // forms of `considered` and `alternatives` should pass.
  const proposalText =
    "I propose we ship the new auth flow. I considered alternatives like SSO and OAuth, " +
    "but rejected those options due to risk and tradeoff cost. The rollout is reversible " +
    "and we know it succeeded when login latency drops below 200ms per Stripe's data.";
  const proposalMissing = await challengeMissing(proposalText);
  ok(
    `oddkit_challenge: P1.3.3 proposal alternatives-considered passes via stemmed match`,
    !includesGap(proposalMissing, "no alternatives mentioned"),
    `missing: ${JSON.stringify(proposalMissing)}`,
  );
  ok(
    `oddkit_challenge: P1.3.3 proposal risk-acknowledged passes via stemmed match`,
    !includesGap(proposalMissing, "no risks or costs"),
    `missing: ${JSON.stringify(proposalMissing)}`,
  );

  // (3) Non-match: input with no keyword overlap and no structural hints
  // surfaces base prereqs (evidence + source + confidence) in missing list.
  const noMatchText = "Let me think about this problem space for a while in abstract terms.";
  const noMatchMissing = await challengeMissing(noMatchText);
  ok(
    `oddkit_challenge: P1.3.3 non-matching input surfaces evidence-cited gap`,
    includesGap(noMatchMissing, "no evidence cited"),
    `missing: ${JSON.stringify(noMatchMissing)}`,
  );

  // (4) URL structural test preservation: source-named passes via the URL
  // structural path even though the input has no quoted-vocab overlap with
  // `per / according to / from / source: / who said / where i read`.
  const urlOnlyText = "I think this works, see https://docs.example.com/auth-flow for the design.";
  const urlMissing = await challengeMissing(urlOnlyText);
  ok(
    `oddkit_challenge: P1.3.3 source-named passes via URL structural test (no keyword overlap)`,
    !includesGap(urlMissing, "no source named"),
    `missing: ${JSON.stringify(urlMissing)}`,
  );

  // (5) Proper-noun structural test preservation: source-named passes via
  // the proper-noun pattern (`per <Capitalized> <Capitalized>`).
  const properNounText =
    "I believe the auth flow needs revisiting based on what I observed per Jane Smith yesterday.";
  const pnMissing = await challengeMissing(properNounText);
  ok(
    `oddkit_challenge: P1.3.3 source-named passes via proper-noun structural test`,
    !includesGap(pnMissing, "no source named"),
    `missing: ${JSON.stringify(pnMissing)}`,
  );

  // (6) Citation structural test preservation: `\baccording to\b` triggers
  // the citation path on a source-named-relevant phrase.
  const citationText =
    "I observed a regression in the deploy pipeline according to Tuesday's measurements [3].";
  const citMissing = await challengeMissing(citationText);
  ok(
    `oddkit_challenge: P1.3.3 source-named passes via citation structural test`,
    !includesGap(citMissing, "no source named"),
    `missing: ${JSON.stringify(citMissing)}`,
  );

  // (7) Rebuild stability — Item 2's inline BM25 type index build per request
  // produces deterministic results across consecutive calls with identical input.
  // (Proxy: same `prerequisites_missing` list across two calls.)
  const stabilityText =
    "I observed a problem with the deploy. According to Jane Smith we should ship the fix.";
  const run1 = await challengeMissing(stabilityText);
  const run2 = await challengeMissing(stabilityText);
  ok(
    `oddkit_challenge: P1.3.3 inline rebuild produces stable results across consecutive calls`,
    JSON.stringify(run1) === JSON.stringify(run2),
    `run1: ${JSON.stringify(run1)}\n           run2: ${JSON.stringify(run2)}`,
  );

  // (8) Backward-compat: pre-refactor regex evaluator passed on inputs containing
  // any quoted keyword (case-insensitive word-boundary). Confirm a literal-keyword
  // input still passes — `"observed"` is in evidence-cited's canon vocab.
  const literalText = "I observed nothing remarkable here per Alice Johnson.";
  const literalMissing = await challengeMissing(literalText);
  ok(
    `oddkit_challenge: P1.3.3 backward-compat — literal canon keyword "observed" still passes evidence-cited`,
    !includesGap(literalMissing, "no evidence cited"),
    `missing: ${JSON.stringify(literalMissing)}`,
  );

  // (9) Confidence-signaled stemmed match — canon vocab includes `believe,
  // think, know, suspect, certain, tentative, confident, unsure`. Stemmed
  // form `believ` matches `I believe` and `believing`.
  const confidenceText =
    "I believe we observed a stable pattern per the measurements from Jane Smith last week.";
  const confMissing = await challengeMissing(confidenceText);
  ok(
    `oddkit_challenge: P1.3.3 confidence-signaled passes via stemmed match on "believe"`,
    !includesGap(confMissing, "confidence level not signaled"),
    `missing: ${JSON.stringify(confMissing)}`,
  );

  // (10) 0.21.1 regression — stop-word canon keywords must survive parse-time
  // tokenization. Bugbot caught this on 0.21.0: `from` is in source-named's
  // canon vocab AND in the default STOP_WORDS set, so the default-filtered
  // tokenize() silently dropped it from both stemmedTokens and inputStems,
  // breaking the strictly-additive invariant. Fix: pass empty Set as
  // stopWords arg to both tokenize() calls. This assertion is the regression
  // anchor.
  const fromOnlySource =
    "I learned this morning that the deploy regressed from my colleague Alex Brown — observed during last night's incident review.";
  const fromMissing = await challengeMissing(fromOnlySource);
  ok(
    `oddkit_challenge: 0.21.1 source-named passes when input matches via stop-word canon keyword "from"`,
    !includesGap(fromMissing, "no source named"),
    `missing: ${JSON.stringify(fromMissing)}`,
  );

  // (11) 0.21.1 regression — verify "according to" (which contains stop-word
  // "to") still passes source-named via the surviving "accord" stem. This is
  // the multi-word phrase case where stop-word filtering would have dropped
  // half the phrase. Pre-fix this still worked (because "accord" survives
  // independently), but the assertion documents the intended behavior.
  const accordingToText =
    "We saw a 30% latency regression according to the Tuesday measurements I observed in the dashboard.";
  const accMissing = await challengeMissing(accordingToText);
  ok(
    `oddkit_challenge: 0.21.1 source-named passes via stemmed "accord" from "according to"`,
    !includesGap(accMissing, "no source named"),
    `missing: ${JSON.stringify(accMissing)}`,
  );

  // Tool 6: oddkit_gate — canon-driven, two governance surfaces. Full envelope +
  // governance_source + governance_uris (plural array of 2 — shape diverges
  // from encode's singular governance_uri, matches challenge's plural shape,
  // structurally cleaner than challenge because both entries are single-file
  // peers). Per PRD D5: transitions use BM25 (ranking problem); prereqs use
  // stemmed set intersection (gap-or-not, avoids BM25 IDF-negative pathology).
  // Stemming is uniform across knowledge_base and minimal tiers.
  console.log(`\n─── oddkit_gate: envelope + governance_source + governance_uris ───`);
  const gateDefault = await callTool("oddkit_gate", {
    input: "ready to build my feature — decisions locked, done when tests pass, no irreversible changes, all constraints addressed",
  });
  expectFullEnvelope("oddkit_gate (default knowledge_base)", gateDefault);
  expectGovernanceSource("oddkit_gate (default knowledge_base)", gateDefault, "knowledge_base");
  ok(
    "oddkit_gate: result.governance_uris is an array of exactly 2 entries",
    Array.isArray(gateDefault.result?.governance_uris) &&
      gateDefault.result?.governance_uris.length === 2,
    `got: ${JSON.stringify(gateDefault.result?.governance_uris)}`,
  );
  const expectedGateUris = [
    "klappy://odd/gate/prerequisites",
    "klappy://odd/gate/transitions",
  ];
  ok(
    "oddkit_gate: governance_uris matches alphabetical peer set",
    JSON.stringify(gateDefault.result?.governance_uris) === JSON.stringify(expectedGateUris),
    `got: ${JSON.stringify(gateDefault.result?.governance_uris)}`,
  );
  ok(
    "oddkit_gate: result.governance_uri (singular) is NOT emitted (divergence from encode by design — PRD D4)",
    gateDefault.result?.governance_uri === undefined,
    `got: ${gateDefault.result?.governance_uri}`,
  );

  console.log(`\n─── oddkit_gate: knowledge_base_url override ───`);
  const gateOverride = await callTool("oddkit_gate", {
    input: "ready to build",
    knowledge_base_url: "https://github.com/torvalds/linux",
  });
  expectFullEnvelope("oddkit_gate (override → linux)", gateOverride);
  ok(
    "oddkit_gate: debug.knowledge_base_url echoed on override",
    gateOverride.debug?.knowledge_base_url === "https://github.com/torvalds/linux",
    `got: ${gateOverride.debug?.knowledge_base_url}`,
  );
  // Known limitation inherited from 0.18.0/0.19.0: getIndex merges baseline
  // entries into the override result, so overrides to repos that lack the
  // expected governance files may still resolve via the baseline tier rather
  // than falling through to minimal. Same assertion pattern as encode's
  // override test — accept either tier rather than forcing "minimal".
  ok(
    "oddkit_gate: governance_source is a valid tier on override",
    ["knowledge_base", "minimal"].includes(gateOverride.result?.governance_source),
    `got: ${gateOverride.result?.governance_source}`,
  );

  console.log(`\n─── oddkit_gate: BM25 transition detection — literal + stemmed variants ───`);
  const transitionCases = [
    { input: "ready to build", expected: "execution", label: "literal planning→execution" },
    { input: "started building the feature", expected: "execution", label: "stemmed: started building → start build" },
    { input: "start planning", expected: "planning", label: "literal exploration→planning" },
    { input: "we're planning the approach", expected: "planning", label: "stemmed: planning → plan" },
    { input: "ship it", expected: "completion", label: "literal execution→completion" },
    { input: "shipping this now", expected: "completion", label: "stemmed: shipping → ship" },
    { input: "step back", expected: "exploration", label: "literal execution→exploration" },
    { input: "stepped back to reconsider", expected: "exploration", label: "stemmed: stepped back → step back" },
    { input: "hello there", expected: "unknown", label: "default guard: no match" },
  ];
  for (const tc of transitionCases) {
    const r = await callTool("oddkit_gate", { input: tc.input });
    ok(
      `oddkit_gate[${tc.label}]: transition.to === "${tc.expected}"`,
      r.result?.transition?.to === tc.expected,
      `input: "${tc.input}" got: ${r.result?.transition?.to}`,
    );
  }

  console.log(`\n─── oddkit_gate: BM25 priority resolution (specific phrase beats bare word) ───`);
  // "ready to build my feature" — "ready" appears in both planning-to-execution
  // and exploration-to-planning vocabularies; "build" only appears in the
  // former. BM25 should score the 2-term match (ready + build) above the
  // 1-term match (ready alone), yielding planning-to-execution. This tests
  // that BM25 scoring replaces the old regex cascade's fragile order-dependent
  // priority resolution.
  const priorityCase = await callTool("oddkit_gate", { input: "ready to build my feature" });
  ok(
    "oddkit_gate: BM25 scoring picks planning-to-execution (specific phrase) over exploration-to-planning (bare 'ready')",
    priorityCase.result?.transition?.to === "execution",
    `got: ${priorityCase.result?.transition?.to}`,
  );

  console.log(`\n─── oddkit_gate: stemmed prereq set-intersection ───`);
  // Prereq check uses stemmed set intersection (not BM25). Input contains:
  // "locked" (→ decisions_locked check vocab "locked"), "done" (→ dod_defined
  // and dod_met), "irreversible" (→ irreversibility_assessed), "addressed"
  // (→ constraints_satisfied check vocab stemmed from "addressed"). With
  // planning→execution transition, all four required prereqs pass.
  const prereqPass = await callTool("oddkit_gate", {
    input: "ready to build — decisions locked, done when tests pass, no irreversible changes, all constraints addressed",
  });
  ok(
    "oddkit_gate: stemmed prereq match produces PASS status",
    prereqPass.result?.status === "PASS",
    `got: ${prereqPass.result?.status} | unmet: ${JSON.stringify(prereqPass.result?.prerequisites?.unmet)}`,
  );
  ok(
    "oddkit_gate: all 4 planning→execution prereqs marked met",
    prereqPass.result?.prerequisites?.required_met === 4 &&
      prereqPass.result?.prerequisites?.required_total === 4,
    `got: met=${prereqPass.result?.prerequisites?.required_met} total=${prereqPass.result?.prerequisites?.required_total}`,
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
