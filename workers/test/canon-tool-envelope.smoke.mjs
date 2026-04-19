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

  // Tool 4: oddkit_encode — canon-driven, DOLCHEO-aware. Full envelope +
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
  ok(
    "oddkit_encode: override pointing at non-canon repo falls through to 'minimal'",
    encodeOverride.result?.governance_source === "minimal",
    `got: ${encodeOverride.result?.governance_source}`,
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
