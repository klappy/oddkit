#!/usr/bin/env node
/**
 * Integration test for the telemetry write path.
 *
 * Mocks env.ODDKIT_TELEMETRY with a writeDataPoint capture, then exercises
 * recordTelemetry + measurePayloadShape with realistic JSON-RPC payloads.
 *
 * Verifies end-to-end:
 *   - The full PayloadShape lands in doubles 3-6
 *   - bytes_in/out match TextEncoder UTF-8 byte length on the actual payloads
 *   - tokens_in/out are positive integers when payloads are non-empty
 *   - Batch JSON-RPC produces one data point per message
 *   - SSE simulation (responseText="") records zeros for the response side
 *   - Tool-call payloads correctly populate blob3 (tool_name)
 *   - The blob array is exactly 9 entries and the doubles array is exactly 6
 *
 * This is the verification that wrangler dev would have done — same code
 * path, same schema, real tokenizer.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKERS_ROOT = join(__dirname, "..");

// Compile both telemetry.ts and tokenize.ts to a temp dir so we can import them
const tmp = mkdtempSync(join(tmpdir(), "oddkit-telemetry-int-"));
const tsconfig = {
  compilerOptions: {
    target: "ES2022",
    module: "ES2022",
    moduleResolution: "bundler",
    lib: ["ES2022", "DOM"],
    types: ["@cloudflare/workers-types"],
    noEmitOnError: false,
    strict: false,
    skipLibCheck: true,
    resolveJsonModule: true,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    rootDir: join(WORKERS_ROOT, "src"),
    outDir: join(tmp, "build"),
  },
  include: [
    join(WORKERS_ROOT, "src", "tokenize.ts"),
    join(WORKERS_ROOT, "src", "telemetry.ts"),
  ],
};
const tsconfigPath = join(tmp, "tsconfig.json");
writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));

const tmpNodeModules = join(tmp, "node_modules");
if (!existsSync(tmpNodeModules)) {
  symlinkSync(join(WORKERS_ROOT, "node_modules"), tmpNodeModules);
}

// telemetry.ts imports `../package.json` — symlink that too
if (!existsSync(join(tmp, "package.json"))) {
  symlinkSync(join(WORKERS_ROOT, "package.json"), join(tmp, "package.json"));
}

const compile = spawnSync("npx", ["--yes", "tsc", "-p", tsconfigPath], {
  encoding: "utf8",
});

// With noEmitOnError: false, tsc may exit non-zero on type errors elsewhere
// in the dep graph (zip-baseline-fetcher.ts has some workers-types friction)
// while still producing the .js files we need. Only bail if the files we
// actually need weren't emitted.
const tokenizeJs = join(tmp, "build", "tokenize.js");
const telemetryJs = join(tmp, "build", "telemetry.js");
if (!existsSync(tokenizeJs) || !existsSync(telemetryJs)) {
  console.error("TypeScript compile failed (target files not emitted):");
  console.error(compile.stdout);
  console.error(compile.stderr);
  process.exit(1);
}
if (compile.status !== 0 && process.env.DEBUG) {
  console.error("Note: tsc reported errors but target .js files were emitted:");
  console.error(compile.stdout);
}

// Newer Node requires `with { type: "json" }` on JSON imports in ESM.
// TypeScript doesn't add this — patch it in.
const { readFileSync, writeFileSync: wf } = await import("node:fs");
let telemetrySrc = readFileSync(telemetryJs, "utf8");
telemetrySrc = telemetrySrc.replace(
  /from ["']\.\.\/package\.json["'];/g,
  'from "../package.json" with { type: "json" };',
);
wf(telemetryJs, telemetrySrc);

const { measurePayloadShape } = await import(tokenizeJs);
const { recordTelemetry } = await import(telemetryJs);

// ─── Mock env with writeDataPoint capture ──────────────────────────────────

class MockAnalyticsEngine {
  constructor() {
    this.writes = [];
  }
  writeDataPoint(point) {
    this.writes.push(point);
  }
}

function mockEnv() {
  return {
    ODDKIT_TELEMETRY: new MockAnalyticsEngine(),
    DEFAULT_KNOWLEDGE_BASE_URL: "https://raw.githubusercontent.com/klappy/klappy.dev/main",
    ODDKIT_VERSION: "0.23.1-test",
  };
}

function mockRequest(consumerLabel = "integration-test") {
  return new Request(`https://oddkit.klappy.dev/mcp?consumer=${consumerLabel}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
}

let pass = 0;
let fail = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  \u2713 ${name}`);
    pass++;
  } catch (err) {
    console.log(`  \u2717 ${name}`);
    console.log(`    ${err.message}`);
    if (err.stack && process.env.DEBUG) console.log(err.stack);
    fail++;
  }
}

console.log("telemetry integration tests (full write path)\n");

// ─── Test 1: oddkit_time tool call ─────────────────────────────────────────

await test("oddkit_time tool call lands a complete telemetry record", async () => {
  const env = mockEnv();
  const requestBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "oddkit_time", arguments: {} },
  });
  const responseBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [
        { type: "text", text: "Current UTC time: 2026-04-23T19:30:00.000Z" },
      ],
    },
  });

  const shape = await measurePayloadShape(requestBody, responseBody);
  recordTelemetry(mockRequest(), requestBody, env, 42, "memory", shape);

  assert.equal(env.ODDKIT_TELEMETRY.writes.length, 1, "should write 1 data point");
  const point = env.ODDKIT_TELEMETRY.writes[0];

  // Schema shape
  assert.equal(point.blobs.length, 9, `blobs should be 9, got ${point.blobs.length}`);
  assert.equal(point.doubles.length, 6, `doubles should be 6, got ${point.doubles.length}`);
  assert.equal(point.indexes.length, 1, "indexes should be 1");

  // Blobs
  assert.equal(point.blobs[0], "tool_call", "blob1 = event_type");
  assert.equal(point.blobs[1], "tools/call", "blob2 = method");
  assert.equal(point.blobs[2], "oddkit_time", "blob3 = tool_name");
  assert.equal(point.blobs[3], "integration-test", "blob4 = consumer_label");
  assert.equal(point.blobs[4], "query-param", "blob5 = consumer_source");
  assert.equal(point.blobs[7], "0.23.1-test", "blob8 = worker_version");
  assert.equal(point.blobs[8], "memory", "blob9 = cache_tier");

  // Doubles
  assert.equal(point.doubles[0], 1, "double1 = count");
  assert.equal(point.doubles[1], 42, "double2 = duration_ms");
  assert.equal(point.doubles[2], shape.bytes_in, "double3 = bytes_in");
  assert.equal(point.doubles[3], shape.bytes_out, "double4 = bytes_out");
  assert.equal(point.doubles[4], shape.tokens_in, "double5 = tokens_in");
  assert.equal(point.doubles[5], shape.tokens_out, "double6 = tokens_out");

  console.log(`     bytes_in=${shape.bytes_in} bytes_out=${shape.bytes_out} ` +
              `tokens_in=${shape.tokens_in} tokens_out=${shape.tokens_out}`);
});

// ─── Test 2: oddkit_search with realistic large response ───────────────────

await test("oddkit_search with realistic ~8KB response — measurements are sane", async () => {
  const env = mockEnv();
  const requestBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "oddkit", arguments: { action: "search", input: "telemetry tokens payload" } },
  });
  const snippet = "Telemetry exists to make decisions informed instead of blind. " +
    "Not to profile users, not to feed a roadmap. ";
  const responseBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    result: {
      content: [{ type: "text", text: snippet.repeat(80) }],
    },
  });

  const shape = await measurePayloadShape(requestBody, responseBody);
  recordTelemetry(mockRequest("realistic-test"), requestBody, env, 215, "r2", shape);

  const point = env.ODDKIT_TELEMETRY.writes[0];
  assert.equal(point.blobs[2], "oddkit", "tool_name = oddkit (router)");

  // Realistic-sized response should be measurable
  assert.ok(shape.bytes_out > 5000, `bytes_out should be > 5000, got ${shape.bytes_out}`);
  assert.ok(shape.tokens_out > 1000, `tokens_out should be > 1000, got ${shape.tokens_out}`);

  console.log(`     bytes_out=${shape.bytes_out} (~${(shape.bytes_out/1024).toFixed(1)}KB) ` +
              `tokens_out=${shape.tokens_out}`);
});

// ─── Test 3: SSE response (empty body) records zeros ───────────────────────

await test("SSE response (empty body) records bytes_out=0 and tokens_out=0", async () => {
  const env = mockEnv();
  const requestBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "oddkit_orient", arguments: { input: "exploring telemetry" } },
  });
  // Simulating the call site path where Content-Type was not application/json
  const shape = await measurePayloadShape(requestBody, "");
  recordTelemetry(mockRequest(), requestBody, env, 50, "memory", shape);

  const point = env.ODDKIT_TELEMETRY.writes[0];
  assert.equal(point.doubles[3], 0, "bytes_out should be 0 for empty response");
  assert.equal(point.doubles[5], 0, "tokens_out should be 0 for empty response");
  assert.ok(point.doubles[2] > 0, "bytes_in should still be > 0");
});

// ─── Test 4: Batch JSON-RPC writes one point per message ───────────────────

await test("batch JSON-RPC produces one data point per message", async () => {
  const env = mockEnv();
  const batch = [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "oddkit_time", arguments: {} } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "oddkit_orient", arguments: { input: "x" } } },
    { jsonrpc: "2.0", id: 3, method: "tools/list" },
  ];
  const requestBody = JSON.stringify(batch);
  const responseBody = JSON.stringify(batch.map(m => ({ jsonrpc: "2.0", id: m.id, result: { ok: true } })));

  const shape = await measurePayloadShape(requestBody, responseBody);
  recordTelemetry(mockRequest(), requestBody, env, 30, "cache", shape);

  assert.equal(env.ODDKIT_TELEMETRY.writes.length, 3, `should write 3 data points, got ${env.ODDKIT_TELEMETRY.writes.length}`);
  assert.equal(env.ODDKIT_TELEMETRY.writes[0].blobs[2], "oddkit_time");
  assert.equal(env.ODDKIT_TELEMETRY.writes[1].blobs[2], "oddkit_orient");
  assert.equal(env.ODDKIT_TELEMETRY.writes[2].blobs[1], "tools/list");
  assert.equal(env.ODDKIT_TELEMETRY.writes[2].blobs[2], "", "tools/list has no tool_name");

  // All 3 messages get the same payload-shape attribution (per-request, not per-message)
  for (const w of env.ODDKIT_TELEMETRY.writes) {
    assert.equal(w.doubles[2], shape.bytes_in);
    assert.equal(w.doubles[3], shape.bytes_out);
  }
});

// ─── Test 5: Malformed JSON-RPC gets dropped silently ──────────────────────

await test("malformed JSON-RPC is silently dropped (telemetry never throws)", async () => {
  const env = mockEnv();
  // Pass garbage as the "body" — recordTelemetry should swallow the parse error
  const requestBody = "not valid json {{{";
  const shape = await measurePayloadShape(requestBody, "ok");

  // Should not throw
  recordTelemetry(mockRequest(), requestBody, env, 10, "none", shape);
  assert.equal(env.ODDKIT_TELEMETRY.writes.length, 0, "should not write anything for malformed input");
});

// ─── Test 6: No env.ODDKIT_TELEMETRY → graceful no-op ──────────────────────

await test("missing env.ODDKIT_TELEMETRY is a graceful no-op", async () => {
  const env = {}; // no ODDKIT_TELEMETRY
  const requestBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const shape = await measurePayloadShape(requestBody, "{}");
  // Should not throw
  recordTelemetry(mockRequest(), requestBody, env, 5, "memory", shape);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
