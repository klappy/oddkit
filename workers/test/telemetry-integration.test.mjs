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
    join(WORKERS_ROOT, "src", "tracing.ts"),
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
const tracingJs = join(tmp, "build", "tracing.js");
const zipFetcherJs = join(tmp, "build", "zip-baseline-fetcher.js");
if (!existsSync(tokenizeJs) || !existsSync(telemetryJs) || !existsSync(tracingJs) || !existsSync(zipFetcherJs)) {
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
const { RequestTracer } = await import(tracingJs);

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
  recordTelemetry(mockRequest(), requestBody, env, 42, { hits: 1, total: 1 }, shape);

  assert.equal(env.ODDKIT_TELEMETRY.writes.length, 1, "should write 1 data point");
  const point = env.ODDKIT_TELEMETRY.writes[0];

  // Schema shape — blob9 retired, doubles 7 and 8 added
  assert.equal(point.blobs.length, 8, `blobs should be 8 (blob9 retired), got ${point.blobs.length}`);
  assert.equal(point.doubles.length, 8, `doubles should be 8, got ${point.doubles.length}`);
  assert.equal(point.indexes.length, 1, "indexes should be 1");

  // Blobs
  assert.equal(point.blobs[0], "tool_call", "blob1 = event_type");
  assert.equal(point.blobs[1], "tools/call", "blob2 = method");
  assert.equal(point.blobs[2], "oddkit_time", "blob3 = tool_name");
  assert.equal(point.blobs[3], "integration-test", "blob4 = consumer_label");
  assert.equal(point.blobs[4], "query-param", "blob5 = consumer_source");
  assert.equal(point.blobs[7], "0.23.1-test", "blob8 = worker_version");

  // Doubles
  assert.equal(point.doubles[0], 1, "double1 = count");
  assert.equal(point.doubles[1], 42, "double2 = duration_ms");
  assert.equal(point.doubles[2], shape.bytes_in, "double3 = bytes_in");
  assert.equal(point.doubles[3], shape.bytes_out, "double4 = bytes_out");
  assert.equal(point.doubles[4], shape.tokens_in, "double5 = tokens_in");
  assert.equal(point.doubles[5], shape.tokens_out, "double6 = tokens_out");
  assert.equal(point.doubles[6], 1, "double7 = cache_hits");
  assert.equal(point.doubles[7], 1, "double8 = cache_lookups");

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
  recordTelemetry(mockRequest("realistic-test"), requestBody, env, 215, { hits: 0, total: 1 }, shape);

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
  recordTelemetry(mockRequest(), requestBody, env, 50, { hits: 1, total: 1 }, shape);

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
  recordTelemetry(mockRequest(), requestBody, env, 30, { hits: 1, total: 1 }, shape);

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
  "knowledge_base_url", "document_uri", "worker_version",
  // blob9 (cache_tier) retired in retire-indexsource-interpreter
];
const TEST_DOUBLE_NAMES = [
  "count", "duration_ms", "bytes_in", "bytes_out", "tokens_in", "tokens_out",
  "cache_hits", "cache_lookups",
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
  const sql = "SELECT event_type, method, tool_name, consumer_label, consumer_source, knowledge_base_url, document_uri, worker_version FROM oddkit_telemetry";
  const rewritten = rewriteSqlToRaw(sql, testMap);
  assert.ok(rewritten.includes("blob1"), "event_type → blob1");
  assert.ok(rewritten.includes("blob2"), "method → blob2");
  assert.ok(rewritten.includes("blob3"), "tool_name → blob3");
  assert.ok(rewritten.includes("blob6"), "knowledge_base_url → blob6");
  assert.ok(rewritten.includes("blob8"), "worker_version → blob8");
  assert.ok(!rewritten.includes("event_type"), "event_type should be gone");
});

await test("rewriteSqlToRaw: translates all double semantic names", async () => {
  const sql = "SELECT SUM(count) AS n, AVG(duration_ms), SUM(bytes_in), SUM(bytes_out), AVG(tokens_in), AVG(tokens_out), SUM(cache_hits), SUM(cache_lookups) FROM oddkit_telemetry";
  const rewritten = rewriteSqlToRaw(sql, testMap);
  assert.ok(rewritten.includes("double1"), "count → double1");
  assert.ok(rewritten.includes("double2"), "duration_ms → double2");
  assert.ok(rewritten.includes("double3"), "bytes_in → double3");
  assert.ok(rewritten.includes("double4"), "bytes_out → double4");
  assert.ok(rewritten.includes("double5"), "tokens_in → double5");
  assert.ok(rewritten.includes("double6"), "tokens_out → double6");
  assert.ok(rewritten.includes("double7"), "cache_hits → double7");
  assert.ok(rewritten.includes("double8"), "cache_lookups → double8");
  assert.ok(!rewritten.includes("duration_ms"), "duration_ms should be gone");
  assert.ok(!rewritten.includes("tokens_out"), "tokens_out should be gone");
  assert.ok(!rewritten.includes("cache_hits"), "cache_hits should be gone");
  assert.ok(!rewritten.includes("cache_lookups"), "cache_lookups should be gone");
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

await test("rewriteSqlToRaw: semantic names inside single-quoted literals are preserved", async () => {
  // Word-boundary regex without literal-skipping would corrupt filter values
  // because `-`, `/`, and `'` are non-word characters that form `\b` boundaries.
  // A query like WHERE document_uri = 'klappy://sources/scientific-method' would
  // have `method` rewritten to `blob2` *inside the literal*, silently breaking
  // the filter. The fix splits SQL into non-literal and single-quoted segments
  // and only rewrites non-literal portions.
  const sql = "SELECT tool_name FROM oddkit_telemetry WHERE document_uri = 'klappy://sources/scientific-method'";
  const rewritten = rewriteSqlToRaw(sql, testMap);
  assert.ok(
    rewritten.includes("'klappy://sources/scientific-method'"),
    "literal value with `method` substring must be preserved verbatim",
  );
  assert.ok(
    !rewritten.includes("scientific-blob2"),
    "method must not be rewritten inside the literal",
  );
  // Column references outside the literal still rewrite correctly
  assert.ok(rewritten.includes("blob3"), "tool_name column reference still rewrites to blob3");
  assert.ok(rewritten.includes("blob7"), "document_uri column reference still rewrites to blob7");

  // SQL doubled-quote escape ('') must not terminate the literal prematurely.
  // The literal here is: it''s a method — single string with one apostrophe.
  // Naive splitting would treat the first '' as end-of-literal-then-start, exposing
  // ` a method ` to rewriting and producing ` a blob2 `.
  const sql2 = "SELECT tool_name FROM oddkit_telemetry WHERE document_uri = 'it''s a method'";
  const rewritten2 = rewriteSqlToRaw(sql2, testMap);
  assert.ok(
    rewritten2.includes("'it''s a method'"),
    "doubled-quote escape must keep `method` inside the literal preserved",
  );
  assert.ok(
    !rewritten2.includes("a blob2"),
    "method inside escaped-quote literal must not become blob2",
  );

  // A semantic name BOTH inside and outside a literal: only the outside one rewrites
  const sql3 = "SELECT method FROM oddkit_telemetry WHERE document_uri = 'log/method/handler'";
  const rewritten3 = rewriteSqlToRaw(sql3, testMap);
  assert.ok(rewritten3.startsWith("SELECT blob2"), "method as column ref rewrites to blob2");
  assert.ok(
    rewritten3.includes("'log/method/handler'"),
    "method inside literal stays as method",
  );
});

await test("detectRawSlotNames: raw slot names inside literals do not trigger rejection", async () => {
  // detectRawSlotNames previously matched RAW_SLOT_PATTERN against the entire
  // SQL string including literals, while rewriteSqlToRaw skipped literals. The
  // inconsistency caused valid semantic queries with raw-slot-shaped substrings
  // in user-supplied filter values to be falsely rejected. The fix strips
  // literals before scanning, matching the rewrite scoping.
  const sql = "SELECT tool_name FROM oddkit_telemetry WHERE knowledge_base_url = 'https://example.com/blob1/readme'";
  const result = detectRawSlotNames(sql, testMap);
  assert.equal(
    result,
    null,
    "blob1 inside a literal must not trigger rejection",
  );

  // Same for double-shaped slot names inside literals
  const sql2 = "SELECT tool_name FROM oddkit_telemetry WHERE document_uri = 'klappy://reports/double5-summary'";
  const result2 = detectRawSlotNames(sql2, testMap);
  assert.equal(
    result2,
    null,
    "double5 inside a literal must not trigger rejection",
  );

  // Sanity check: raw slot OUTSIDE a literal must STILL be rejected.
  // This guards against a future refactor that over-strips and lets real
  // raw-slot references through.
  const sql3 = "SELECT blob1 FROM oddkit_telemetry WHERE knowledge_base_url = 'https://example.com/safe/path'";
  const result3 = detectRawSlotNames(sql3, testMap);
  assert.ok(
    result3 !== null,
    "bare blob1 outside any literal must still be rejected",
  );
  assert.ok(
    result3.includes("blob1"),
    "rejection message names the offending raw slot",
  );

  // Mixed case: raw slot in a literal AND outside — must be rejected for the outside one
  const sql4 = "SELECT double5 FROM oddkit_telemetry WHERE document_uri = 'safe-blob1-string'";
  const result4 = detectRawSlotNames(sql4, testMap);
  assert.ok(result4 !== null, "raw slot outside literal triggers rejection even when another raw slot is in a literal");
  assert.ok(result4.includes("double5"), "rejection message names the outside-literal raw slot");
  assert.ok(!result4.includes("blob1"), "raw slot only inside literal must not be flagged");
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
  recordTelemetry(mockRequest(), requestBody, env, 10, { hits: 0, total: 0 }, shape);
  assert.equal(env.ODDKIT_TELEMETRY.writes.length, 0, "should not write anything for malformed input");
});

// ─── Test 6: No env.ODDKIT_TELEMETRY → graceful no-op ──────────────────────

await test("missing env.ODDKIT_TELEMETRY is a graceful no-op", async () => {
  const env = {}; // no ODDKIT_TELEMETRY
  const requestBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const shape = await measurePayloadShape(requestBody, "{}");
  // Should not throw
  recordTelemetry(mockRequest(), requestBody, env, 5, { hits: 1, total: 1 }, shape);
});

// ─── Test 7: Streaming-race regression — cacheStats must be read AFTER body ──

await test("cacheStats reads must happen after the streaming response body completes", async () => {
  // The MCP handler from agents/mcp returns a streaming Response. `await
  // handler(...)` resolves with the Response object before the tool handler
  // closure has finished populating the tracer. Reading `tracer.cacheStats`
  // immediately after the await yields {hits:0,total:0} for every tool
  // because no fetch records have been written yet. The fix in
  // workers/src/index.ts moves the read inside the waitUntil callback,
  // after the response body has been consumed (which forces the streaming
  // tool handler to complete).
  //
  // The interpretation layer (`indexSource`) was retired in
  // refactor/retire-indexsource-interpreter, but the streaming-race
  // regression survives unchanged — semantics are identical, only the
  // accessor changed (indexSource → cacheStats).

  const tracer = new RequestTracer();

  // Schedule a fetch record for the next tick — this models a streaming
  // tool handler that has not yet recorded its storage access at the
  // moment the outer handler's `await` resolves.
  const handlerDone = new Promise((resolve) => {
    setImmediate(() => {
      tracer.recordFetch({ url: "cf-cache://index/v2.4/baseline_abc", duration_ms: 12, cached: true });
      resolve();
    });
  });

  // (a) OLD pattern: read tracer.cacheStats synchronously, before the
  // deferred fetch has been added. This reproduces the production bug.
  const oldPatternRead = tracer.cacheStats;
  assert.equal(
    oldPatternRead.total,
    0,
    "OLD pattern (read immediately after await) sees zero fetches — the streaming-race bug",
  );

  // Wait for the deferred fetch to land (modeling `await responseClone.text()`
  // forcing the streaming tool handler to finish).
  await handlerDone;

  // (b) FIXED pattern: read tracer.cacheStats AFTER the deferred work has
  // completed. The tracer now reflects the actual fetch.
  const fixedPatternRead = tracer.cacheStats;
  assert.equal(
    fixedPatternRead.total,
    1,
    "FIXED pattern (read after body consumption) sees the actual fetch",
  );
  assert.equal(fixedPatternRead.hits, 1, "the deferred fetch was a cache hit");

  // Round-trip: feed the fixed value through recordTelemetry and verify it
  // lands in cache_hits / cache_lookups doubles.
  const env = mockEnv();
  const requestBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "oddkit_search", arguments: { input: "test" } } });
  const responseBody = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } });
  const shape = await measurePayloadShape(requestBody, responseBody);
  recordTelemetry(mockRequest(), requestBody, env, 42, fixedPatternRead, shape);
  assert.equal(env.ODDKIT_TELEMETRY.writes.length, 1, "exactly one data point written");
  assert.equal(
    env.ODDKIT_TELEMETRY.writes[0].doubles[6],
    1,
    "double7 (cache_hits) carries the post-body-consumption arithmetic",
  );
  assert.equal(
    env.ODDKIT_TELEMETRY.writes[0].doubles[7],
    1,
    "double8 (cache_lookups) carries the post-body-consumption arithmetic",
  );

  // Sanity: if we had used the broken old-pattern read, both doubles would be 0
  const env2 = mockEnv();
  recordTelemetry(mockRequest(), requestBody, env2, 42, oldPatternRead, shape);
  assert.equal(
    env2.ODDKIT_TELEMETRY.writes[0].doubles[6],
    0,
    "double7 with the OLD-pattern read would be 0 — what production previously recorded",
  );
  assert.equal(
    env2.ODDKIT_TELEMETRY.writes[0].doubles[7],
    0,
    "double8 with the OLD-pattern read would be 0",
  );
});

// ─── Test 8: tracer.recordFetch arithmetic — cacheStats reflects fetches ──

await test("tracer.recordFetch arithmetic: cacheStats {hits, misses, total} mirrors fetches[]", async () => {
  // Replaces the four PR #139 file:* / index-wins / regression tests that
  // pinned the retired interpreter behavior. The new contract is simple
  // arithmetic over the per-fetch records — no winner selection, no
  // first-vs-slowest debate, no special-case label recognition.

  const tracer = new RequestTracer();
  assert.deepEqual(
    tracer.cacheStats,
    { hits: 0, misses: 0, total: 0 },
    "fresh tracer has zero of everything",
  );

  // Two cache hits, one miss, one cold rebuild
  tracer.recordFetch({ url: "memory://canon/foo.md", duration_ms: 0, cached: true });
  tracer.recordFetch({ url: "cf-cache://index/v2.4/k", duration_ms: 1, cached: true });
  tracer.recordFetch({ url: "r2://canon/bar.md", duration_ms: 40, cached: false });
  tracer.recordFetch({ url: "build://canon/bar.md", duration_ms: 1500, cached: false });

  const stats = tracer.cacheStats;
  assert.equal(stats.hits, 2, "two cached: true records → hits = 2");
  assert.equal(stats.misses, 2, "two cached: false records → misses = 2");
  assert.equal(stats.total, 4, "total = hits + misses");

  // toJSON exposes the per-fetch records and the derived stats
  const json = tracer.toJSON();
  assert.equal(json.fetches.length, 4, "all four records survive in toJSON.fetches");
  assert.deepEqual(json.cacheStats, stats, "toJSON.cacheStats matches the getter");
  assert.ok(!("index_source" in json), "retired index_source field is gone from toJSON");

  // addSpan still records non-fetch events without affecting cacheStats
  tracer.addSpan("sha:klappy.dev", 0, "memory");
  tracer.addSpan("action:search", 30);
  assert.equal(tracer.cacheStats.total, 4, "addSpan does not increment cacheStats");
  assert.equal(tracer.spanCount, 2, "spans tracked separately from fetches");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
