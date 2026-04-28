#!/usr/bin/env node
/**
 * Unit + integration tests for the result_grouping feature (#150).
 *
 * Tests:
 *   - partitionBySource: stable partition, edge cases, ordering guarantees
 *   - Conditional default: KB set → overlay_first, KB unset → merged
 *   - Grouped shape construction: overlay_hits / baseline_hits arrays
 *   - Preflight partition: start_here_overlay / start_here_baseline
 *   - Telemetry: blob9 carries result_grouping value
 *
 * Compiles orchestrate.ts + telemetry.ts via tsc into a temp dir, then
 * dynamic-imports the compiled .js. Same pattern as tokenize.test.mjs
 * and telemetry-integration.test.mjs.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, symlinkSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKERS_ROOT = join(__dirname, "..");

// ─── Compile orchestrate.ts + telemetry.ts to temp dir ────────────────────

const tmp = mkdtempSync(join(tmpdir(), "oddkit-result-grouping-test-"));
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
    join(WORKERS_ROOT, "src", "orchestrate.ts"),
    join(WORKERS_ROOT, "src", "telemetry.ts"),
    join(WORKERS_ROOT, "src", "tracing.ts"),
    join(WORKERS_ROOT, "src", "zip-baseline-fetcher.ts"),
    join(WORKERS_ROOT, "src", "bm25.ts"),
    join(WORKERS_ROOT, "src", "markdown-utils.ts"),
  ],
};
const tsconfigPath = join(tmp, "tsconfig.json");
writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));

const tmpNodeModules = join(tmp, "node_modules");
if (!existsSync(tmpNodeModules)) {
  symlinkSync(join(WORKERS_ROOT, "node_modules"), tmpNodeModules);
}
// orchestrate.ts imports ../package.json
if (!existsSync(join(tmp, "package.json"))) {
  symlinkSync(join(WORKERS_ROOT, "package.json"), join(tmp, "package.json"));
}

const compile = spawnSync("npx", ["--yes", "tsc", "-p", tsconfigPath], {
  encoding: "utf8",
});

// With noEmitOnError: false, tsc may exit non-zero on type errors in the dep
// graph (zip-baseline-fetcher.ts has workers-types friction) while still
// producing the .js files we need. Only bail if target files weren't emitted.
const buildDir = join(tmp, "build");
const orchestrateJs = join(buildDir, "orchestrate.js");
const telemetryJs = join(buildDir, "telemetry.js");
if (!existsSync(orchestrateJs) || !existsSync(telemetryJs)) {
  console.error("TypeScript compile failed (target files not emitted):");
  console.error(compile.stdout);
  console.error(compile.stderr);
  process.exit(1);
}
if (compile.status !== 0 && process.env.DEBUG) {
  console.error("Note: tsc reported errors but target .js files were emitted:");
  console.error(compile.stdout);
}

// Patch compiled files: JSON import assertions + extensionless local imports
for (const f of readdirSync(buildDir).filter((n) => n.endsWith(".js"))) {
  const fpath = join(buildDir, f);
  let src = readFileSync(fpath, "utf8");
  src = src.replace(
    /from ["']\.\.\/package\.json["'];/g,
    'from "../package.json" with { type: "json" };',
  );
  src = src.replace(
    /from ["'](\.\/[^"'.]+)["'];/g,
    'from "$1.js";',
  );
  writeFileSync(fpath, src);
}

// Import the compiled module
const { partitionBySource } = await import(orchestrateJs);
const { recordTelemetry, parseToolCall } = await import(telemetryJs);

// Also import tokenize for telemetry shape tests
const tokenizeJs = join(buildDir, "tokenize.js");
let measurePayloadShape = null;
if (existsSync(tokenizeJs)) {
  const tok = await import(tokenizeJs);
  measurePayloadShape = tok.measurePayloadShape;
}

// ─── Test harness ─────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    if (err.stack && process.env.DEBUG) console.log(err.stack);
    fail++;
  }
}

console.log("result-grouping tests (#150)\n");

// ─── Test fixtures ────────────────────────────────────────────────────────

// Fixture: mixed entries with interleaving scores
// canon entries have scores 10, 6 (ranked 1st, 3rd in BM25 order)
// baseline entries have scores 8, 4 (ranked 2nd, 4th in BM25 order)
// This ensures partition actually reorders — a fixture where canon always
// outscores baseline would prove nothing.
const mixedHits = [
  { path: "canon/a.md", title: "Canon A", source: "canon", score: 10 },
  { path: "docs/b.md", title: "Baseline B", source: "baseline", score: 8 },
  { path: "canon/c.md", title: "Canon C", source: "canon", score: 6 },
  { path: "docs/d.md", title: "Baseline D", source: "baseline", score: 4 },
];

const canonOnly = [
  { path: "canon/x.md", title: "Canon X", source: "canon", score: 10 },
  { path: "canon/y.md", title: "Canon Y", source: "canon", score: 5 },
];

const baselineOnly = [
  { path: "docs/m.md", title: "Baseline M", source: "baseline", score: 9 },
  { path: "docs/n.md", title: "Baseline N", source: "baseline", score: 3 },
];

// ─── partitionBySource tests ──────────────────────────────────────────────

console.log("partitionBySource:");

await test("splits mixed entries into overlay (canon) and baseline", () => {
  const { overlay, baseline } = partitionBySource(mixedHits);
  assert.equal(overlay.length, 2, "should have 2 overlay entries");
  assert.equal(baseline.length, 2, "should have 2 baseline entries");
  assert.ok(overlay.every((h) => h.source === "canon"), "all overlay should be canon");
  assert.ok(baseline.every((h) => h.source === "baseline"), "all baseline should be baseline");
});

await test("preserves BM25 score order within each partition (stability)", () => {
  const { overlay, baseline } = partitionBySource(mixedHits);
  // overlay: canon/a (10) then canon/c (6)
  assert.equal(overlay[0].path, "canon/a.md");
  assert.equal(overlay[1].path, "canon/c.md");
  assert.ok(overlay[0].score >= overlay[1].score, "overlay should be descending score");
  // baseline: docs/b (8) then docs/d (4)
  assert.equal(baseline[0].path, "docs/b.md");
  assert.equal(baseline[1].path, "docs/d.md");
  assert.ok(baseline[0].score >= baseline[1].score, "baseline should be descending score");
});

await test("overlay_first reorder: all canon before all baseline", () => {
  const { overlay, baseline } = partitionBySource(mixedHits);
  const ordered = [...overlay, ...baseline];
  // Expected: canon/a(10), canon/c(6), docs/b(8), docs/d(4)
  assert.equal(ordered[0].source, "canon");
  assert.equal(ordered[1].source, "canon");
  assert.equal(ordered[2].source, "baseline");
  assert.equal(ordered[3].source, "baseline");
  // Scores within tiers are descending
  assert.ok(ordered[0].score >= ordered[1].score);
  assert.ok(ordered[2].score >= ordered[3].score);
});

await test("canon-only input: overlay = all, baseline = empty", () => {
  const { overlay, baseline } = partitionBySource(canonOnly);
  assert.equal(overlay.length, 2);
  assert.equal(baseline.length, 0);
});

await test("baseline-only input: overlay = empty, baseline = all", () => {
  const { overlay, baseline } = partitionBySource(baselineOnly);
  assert.equal(overlay.length, 0);
  assert.equal(baseline.length, 2);
});

await test("empty array: both partitions empty", () => {
  const { overlay, baseline } = partitionBySource([]);
  assert.equal(overlay.length, 0);
  assert.equal(baseline.length, 0);
});

await test("stability: entries with identical scores retain pre-partition relative order", () => {
  const sameScore = [
    { path: "canon/first.md", source: "canon", score: 5 },
    { path: "docs/between.md", source: "baseline", score: 5 },
    { path: "canon/second.md", source: "canon", score: 5 },
    { path: "docs/last.md", source: "baseline", score: 5 },
  ];
  const { overlay, baseline } = partitionBySource(sameScore);
  // Within canon: first then second (insertion order preserved)
  assert.equal(overlay[0].path, "canon/first.md");
  assert.equal(overlay[1].path, "canon/second.md");
  // Within baseline: between then last (insertion order preserved)
  assert.equal(baseline[0].path, "docs/between.md");
  assert.equal(baseline[1].path, "docs/last.md");
});

// ─── Conditional default logic tests ──────────────────────────────────────

console.log("\nconditional default:");

await test("KB unset → default is merged", () => {
  const knowledge_base_url = undefined;
  const result_grouping = undefined;
  const resolved = result_grouping ?? (knowledge_base_url ? "overlay_first" : "merged");
  assert.equal(resolved, "merged");
});

await test("KB set → default is overlay_first", () => {
  const knowledge_base_url = "https://github.com/klappy/klappy.dev";
  const result_grouping = undefined;
  const resolved = result_grouping ?? (knowledge_base_url ? "overlay_first" : "merged");
  assert.equal(resolved, "overlay_first");
});

await test("explicit merged overrides KB-set default", () => {
  const knowledge_base_url = "https://github.com/klappy/klappy.dev";
  const result_grouping = "merged";
  const resolved = result_grouping ?? (knowledge_base_url ? "overlay_first" : "merged");
  assert.equal(resolved, "merged");
});

await test("explicit overlay_first works with KB unset", () => {
  const knowledge_base_url = undefined;
  const result_grouping = "overlay_first";
  const resolved = result_grouping ?? (knowledge_base_url ? "overlay_first" : "merged");
  assert.equal(resolved, "overlay_first");
});

await test("explicit grouped works regardless of KB", () => {
  for (const kb of [undefined, "https://github.com/klappy/klappy.dev"]) {
    const result_grouping = "grouped";
    const resolved = result_grouping ?? (kb ? "overlay_first" : "merged");
    assert.equal(resolved, "grouped", `should be grouped when kb=${kb}`);
  }
});

// ─── Grouped shape construction tests ─────────────────────────────────────

console.log("\ngrouped shape construction:");

await test("grouped search: overlay_hits and baseline_hits arrays present and correct", () => {
  // Simulate the grouped shape construction from runSearch
  const orderedHits = (() => {
    const { overlay, baseline } = partitionBySource(mixedHits);
    return [...overlay, ...baseline];
  })();

  // Simulate metadata enrichment (adds uri field)
  const hitsWithMetadata = orderedHits.map((h) => ({
    uri: `klappy://${h.path.replace(".md", "")}`,
    path: h.path,
    title: h.title,
    score: h.score,
    source: h.source,
  }));

  // Build grouped shape
  const overlayHits = [];
  const baselineHits = [];
  for (const h of hitsWithMetadata) {
    (h.source === "canon" ? overlayHits : baselineHits).push(h);
  }

  // Assertions
  assert.equal(overlayHits.length, 2, "overlay_hits should have 2 items");
  assert.equal(baselineHits.length, 2, "baseline_hits should have 2 items");
  assert.ok(overlayHits.every((h) => h.source === "canon"));
  assert.ok(baselineHits.every((h) => h.source === "baseline"));

  // hits (back-compat) is overlay-then-baseline
  assert.equal(hitsWithMetadata[0].source, "canon");
  assert.equal(hitsWithMetadata[1].source, "canon");
  assert.equal(hitsWithMetadata[2].source, "baseline");
  assert.equal(hitsWithMetadata[3].source, "baseline");
});

await test("grouped with empty overlay: overlay_hits=[], baseline_hits=[...]", () => {
  const { overlay, baseline } = partitionBySource(baselineOnly);
  assert.equal(overlay.length, 0);
  assert.equal(baseline.length, 2);

  const orderedHits = [...overlay, ...baseline];
  assert.equal(orderedHits.length, 2);
  assert.ok(orderedHits.every((h) => h.source === "baseline"));
});

await test("grouped with empty baseline: overlay_hits=[...], baseline_hits=[]", () => {
  const { overlay, baseline } = partitionBySource(canonOnly);
  assert.equal(overlay.length, 2);
  assert.equal(baseline.length, 0);

  const orderedHits = [...overlay, ...baseline];
  assert.equal(orderedHits.length, 2);
  assert.ok(orderedHits.every((h) => h.source === "canon"));
});

// ─── Preflight partition tests ────────────────────────────────────────────

console.log("\npreflight partition:");

await test("preflight overlay_first: partition applied before slice", () => {
  // Simulate scoreEntries output with interleaving scores
  const allScored = [
    { path: "docs/high.md", source: "baseline", score: 20 },
    { path: "canon/mid-high.md", source: "canon", score: 18 },
    { path: "docs/mid.md", source: "baseline", score: 15 },
    { path: "canon/mid-low.md", source: "canon", score: 12 },
    { path: "docs/low.md", source: "baseline", score: 8 },
    { path: "canon/lowest.md", source: "canon", score: 3 },
  ];

  // overlay_first: partition then slice(0, 5)
  const { overlay, baseline } = partitionBySource(allScored);
  const ordered = [...overlay, ...baseline];
  const results = ordered.slice(0, 5);
  const startHere = results.slice(0, 3).map((r) => r.path);

  // First 3 results should be all canon (3 canon entries exist)
  assert.equal(startHere[0], "canon/mid-high.md");
  assert.equal(startHere[1], "canon/mid-low.md");
  assert.equal(startHere[2], "canon/lowest.md");
});

await test("preflight grouped: start_here_overlay and start_here_baseline", () => {
  const allScored = [
    { path: "docs/high.md", source: "baseline", score: 20 },
    { path: "canon/mid-high.md", source: "canon", score: 18 },
    { path: "docs/mid.md", source: "baseline", score: 15 },
    { path: "canon/mid-low.md", source: "canon", score: 12 },
  ];

  const { overlay, baseline } = partitionBySource(allScored);
  const startHereOverlay = overlay.slice(0, 3).map((r) => r.path);
  const startHereBaseline = baseline.slice(0, 3).map((r) => r.path);

  assert.deepEqual(startHereOverlay, ["canon/mid-high.md", "canon/mid-low.md"]);
  assert.deepEqual(startHereBaseline, ["docs/high.md", "docs/mid.md"]);
});

await test("preflight merged: no partition applied (pure score order)", () => {
  const allScored = [
    { path: "docs/high.md", source: "baseline", score: 20 },
    { path: "canon/mid-high.md", source: "canon", score: 18 },
    { path: "docs/mid.md", source: "baseline", score: 15 },
  ];

  // merged = just use allScored directly
  const startHere = allScored.slice(0, 3).map((r) => r.path);
  assert.deepEqual(startHere, ["docs/high.md", "canon/mid-high.md", "docs/mid.md"]);
});

// ─── Telemetry: parseToolCall extracts result_grouping ────────────────────

console.log("\ntelemetry:");

await test("parseToolCall extracts result_grouping from oddkit_search arguments", () => {
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "oddkit_search",
      arguments: {
        input: "test query",
        knowledge_base_url: "https://github.com/klappy/klappy.dev",
        result_grouping: "overlay_first",
      },
    },
  };
  const result = parseToolCall(payload);
  assert.ok(result, "should parse tool call");
  assert.equal(result.resultGrouping, "overlay_first");
  assert.equal(result.knowledgeBaseUrl, "https://github.com/klappy/klappy.dev");
});

await test("parseToolCall returns empty result_grouping when not specified", () => {
  const payload = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "oddkit_search",
      arguments: { input: "test query" },
    },
  };
  const result = parseToolCall(payload);
  assert.ok(result);
  assert.equal(result.resultGrouping, "");
});

await test("parseToolCall returns empty result_grouping for non-search tools", () => {
  const payload = {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "oddkit_orient",
      arguments: { input: "exploring" },
    },
  };
  const result = parseToolCall(payload);
  assert.ok(result);
  assert.equal(result.resultGrouping, "");
});

// ─── Telemetry: recordTelemetry writes result_grouping to blob9 ───────────

class MockAnalyticsEngine {
  constructor() { this.writes = []; }
  writeDataPoint(point) { this.writes.push(point); }
}

function mockEnv() {
  return {
    ODDKIT_TELEMETRY: new MockAnalyticsEngine(),
    DEFAULT_KNOWLEDGE_BASE_URL: "https://raw.githubusercontent.com/klappy/klappy.dev/main",
    ODDKIT_VERSION: "0.test.0",
  };
}

function mockRequest(consumer = "test") {
  return new Request(`https://oddkit.klappy.dev/mcp?consumer=${consumer}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
}

await test("recordTelemetry writes result_grouping to blob9", async () => {
  const env = mockEnv();
  const requestBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "oddkit_search",
      arguments: {
        input: "test",
        result_grouping: "overlay_first",
      },
    },
  });
  const responseBody = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } });

  let shape = null;
  if (measurePayloadShape) {
    shape = await measurePayloadShape(requestBody, responseBody);
  }
  recordTelemetry(mockRequest(), requestBody, env, 42, { hits: 0, total: 0 }, shape);

  assert.equal(env.ODDKIT_TELEMETRY.writes.length, 1);
  const point = env.ODDKIT_TELEMETRY.writes[0];
  assert.equal(point.blobs.length, 9, `blobs should be 9, got ${point.blobs.length}`);
  assert.equal(point.blobs[8], "overlay_first", "blob9 should be result_grouping value");
});

await test("recordTelemetry writes empty blob9 for non-search tools", async () => {
  const env = mockEnv();
  const requestBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "oddkit_orient",
      arguments: { input: "test" },
    },
  });
  const responseBody = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } });

  let shape = null;
  if (measurePayloadShape) {
    shape = await measurePayloadShape(requestBody, responseBody);
  }
  recordTelemetry(mockRequest(), requestBody, env, 10, { hits: 0, total: 0 }, shape);

  const point = env.ODDKIT_TELEMETRY.writes[0];
  assert.equal(point.blobs[8], "", "blob9 should be empty for non-search tools");
});

await test("recordTelemetry writes empty blob9 for non-tool-call requests", async () => {
  const env = mockEnv();
  const requestBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });

  recordTelemetry(mockRequest(), requestBody, env, 5, { hits: 0, total: 0 }, null);

  const point = env.ODDKIT_TELEMETRY.writes[0];
  // Non-tool-call: toolCall is null, so blob9 gets ?? "" fallback
  // The blobs array for non-tool-call may be shorter (8) since toolCall is null
  // and the resultGrouping path uses toolCall?.resultGrouping ?? ""
  assert.equal(point.blobs.length, 9, "blobs should still be 9");
  assert.equal(point.blobs[8], "", "blob9 should be empty for non-tool-call");
});

// ─── Summary ──────────────────────────────────────────────────────────────

console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
