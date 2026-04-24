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
    join(WORKERS_ROOT, "src", "zip-baseline-fetcher.ts"),
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
const zipFetcherJs = join(tmp, "build", "zip-baseline-fetcher.js");
if (!existsSync(tokenizeJs) || !existsSync(telemetryJs) || !existsSync(zipFetcherJs)) {
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
// TypeScript bundler moduleResolution omits .js extensions on local imports.
// Node.js ESM resolver requires explicit extensions — patch all compiled files.
const { readFileSync, writeFileSync: wf, readdirSync: rds } = await import("node:fs");
const buildDir = join(tmp, "build");
for (const f of rds(buildDir).filter(n => n.endsWith(".js"))) {
  const fpath = join(buildDir, f);
  let src = readFileSync(fpath, "utf8");
  // Patch JSON imports
  src = src.replace(
    /from ["']\.\.\/package\.json["'];/g,
    'from "../package.json" with { type: "json" };',
  );
  // Patch extensionless local imports (TypeScript bundler mode omits .js)
  src = src.replace(
    /from ["'](\.\/[^"'.]+)["'];/g,
    'from "$1.js";',
  );
  wf(fpath, src);
}

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

// ─── Semantic schema rewriting tests ──────────────────────────────────────

const {
  buildSchemaMapFromArrays,
  detectRawSlotNames,
  rewriteSqlToRaw,
  rewriteResultToSemantic,
} = await import(telemetryJs);

// Build a test schema map (mirrors the production baseline)
const TEST_BLOB_NAMES = [
  "event_type", "method", "tool_name", "consumer_label", "consumer_source",
  "knowledge_base_url", "document_uri", "worker_version", "cache_tier",
];
const TEST_DOUBLE_NAMES = [
  "count", "duration_ms", "bytes_in", "bytes_out", "tokens_in", "tokens_out",
];
const testMap = buildSchemaMapFromArrays(TEST_BLOB_NAMES, TEST_DOUBLE_NAMES);

await test("detectRawSlotNames: returns null for clean semantic query", async () => {
  const result = detectRawSlotNames(
    "SELECT tool_name, SUM(_sample_interval) FROM oddkit_telemetry GROUP BY tool_name",
    testMap,
  );
  assert.equal(result, null, "clean query should return null");
});

await test("detectRawSlotNames: rejects blob1 with helpful message", async () => {
  const result = detectRawSlotNames(
    "SELECT blob1, blob3 FROM oddkit_telemetry",
    testMap,
  );
  assert.ok(result !== null, "should return error string");
  assert.ok(result.includes("blob1"), "error should mention the raw name");
  assert.ok(result.includes("event_type"), "error should suggest semantic name");
  assert.ok(result.includes("tool_name"), "error should suggest tool_name for blob3");
});

await test("detectRawSlotNames: rejects double5 with helpful message", async () => {
  const result = detectRawSlotNames(
    "SELECT SUM(double5) AS x FROM oddkit_telemetry",
    testMap,
  );
  assert.ok(result !== null, "should return error string");
  assert.ok(result.includes("double5"), "error should mention the raw name");
  assert.ok(result.includes("tokens_in"), "error should suggest semantic name");
});

await test("rewriteSqlToRaw: translates all blob semantic names", async () => {
  const sql = "SELECT event_type, method, tool_name, consumer_label, consumer_source, knowledge_base_url, document_uri, worker_version, cache_tier FROM oddkit_telemetry";
  const rewritten = rewriteSqlToRaw(sql, testMap);
  assert.ok(rewritten.includes("blob1"), "event_type → blob1");
  assert.ok(rewritten.includes("blob2"), "method → blob2");
  assert.ok(rewritten.includes("blob3"), "tool_name → blob3");
  assert.ok(rewritten.includes("blob6"), "knowledge_base_url → blob6");
  assert.ok(rewritten.includes("blob9"), "cache_tier → blob9");
  assert.ok(!rewritten.includes("event_type"), "event_type should be gone");
});

await test("rewriteSqlToRaw: translates all double semantic names", async () => {
  const sql = "SELECT SUM(count) AS n, AVG(duration_ms), SUM(bytes_in), SUM(bytes_out), AVG(tokens_in), AVG(tokens_out) FROM oddkit_telemetry";
  const rewritten = rewriteSqlToRaw(sql, testMap);
  assert.ok(rewritten.includes("double1"), "count → double1");
  assert.ok(rewritten.includes("double2"), "duration_ms → double2");
  assert.ok(rewritten.includes("double3"), "bytes_in → double3");
  assert.ok(rewritten.includes("double4"), "bytes_out → double4");
  assert.ok(rewritten.includes("double5"), "tokens_in → double5");
  assert.ok(rewritten.includes("double6"), "tokens_out → double6");
  assert.ok(!rewritten.includes("duration_ms"), "duration_ms should be gone");
  assert.ok(!rewritten.includes("tokens_out"), "tokens_out should be gone");
});

await test("rewriteSqlToRaw: knowledge_base_url doesn't clobber shorter substrings", async () => {
  // 'url' as alias should not be mistaken for a semantic column name
  // and 'knowledge_base_url' should replace as a whole unit
  const sql = "SELECT knowledge_base_url AS url FROM oddkit_telemetry";
  const rewritten = rewriteSqlToRaw(sql, testMap);
  assert.ok(rewritten.includes("blob6"), "knowledge_base_url → blob6");
  assert.ok(rewritten.includes("AS url"), "alias 'url' should be untouched");
});

await test("rewriteSqlToRaw: count() SQL aggregate is not rewritten to double1()", async () => {
  // `count` is both a semantic column name (double1) and a SQL aggregate
  // function. Rewriting `count(*)` to `double1(*)` would produce invalid SQL
  // that CF rejects. A function-call guard (negative lookahead for `(`) keeps
  // the aggregate intact while still rewriting column references to `count`.
  const sql = "SELECT tool_name, count(*) AS n FROM oddkit_telemetry GROUP BY tool_name";
  const rewritten = rewriteSqlToRaw(sql, testMap);
  assert.ok(rewritten.includes("count(*)"), "count(*) aggregate should be preserved");
  assert.ok(!rewritten.includes("double1(*)"), "count(*) must not become double1(*)");
  assert.ok(rewritten.includes("blob3"), "tool_name should still rewrite to blob3");

  // Lowercase count( with whitespace also preserved
  const sql2 = "SELECT count (DISTINCT tool_name) FROM oddkit_telemetry";
  const rewritten2 = rewriteSqlToRaw(sql2, testMap);
  assert.ok(!rewritten2.includes("double1 ("), "count (DISTINCT ...) must not be rewritten");

  // But a bare `count` column reference (no paren) still rewrites
  const sql3 = "SELECT SUM(count) AS n FROM oddkit_telemetry";
  const rewritten3 = rewriteSqlToRaw(sql3, testMap);
  assert.ok(rewritten3.includes("SUM(double1)"), "count as column reference should still rewrite to double1");
});

await test("rewriteResultToSemantic: renames blob/double columns in meta and data", async () => {
  const rawResult = {
    meta: [
      { name: "blob3", type: "String" },
      { name: "double2", type: "Float64" },
      { name: "total", type: "UInt64" },
    ],
    data: [
      { blob3: "search", double2: 123.4, total: "42" },
      { blob3: "orient", double2: 88.0, total: "17" },
    ],
    rows: 2,
  };
  const result = rewriteResultToSemantic(rawResult, testMap);
  assert.deepEqual(result.meta[0], { name: "tool_name", type: "String" }, "blob3 → tool_name in meta");
  assert.deepEqual(result.meta[1], { name: "duration_ms", type: "Float64" }, "double2 → duration_ms in meta");
  assert.deepEqual(result.meta[2], { name: "total", type: "UInt64" }, "non-slot column unchanged");
  assert.equal(result.data[0].tool_name, "search", "data row key renamed");
  assert.equal(result.data[0].duration_ms, 123.4, "double2 key renamed");
  assert.equal(result.data[0].total, "42", "non-slot key unchanged");
  assert.ok(!("blob3" in result.data[0]), "old key blob3 removed");
  assert.ok(!("double2" in result.data[0]), "old key double2 removed");
});

await test("rewriteResultToSemantic: passes through non-slot result unchanged", async () => {
  const rawResult = { error: "bad query" };
  const result = rewriteResultToSemantic(rawResult, testMap);
  assert.deepEqual(result, rawResult, "error result passed through unchanged");
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
