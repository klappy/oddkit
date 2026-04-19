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

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
