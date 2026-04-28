#!/usr/bin/env node
/**
 * Unit test for overlay-first re-ranking when knowledge_base_url is set.
 *
 * Issue #150 — Option D1: when a project KB overlay is merged with the
 * klappy.dev baseline corpus, search/preflight must surface overlay docs
 * (source: "canon") above baseline docs (source: "baseline"). BM25 still
 * orders within each tier, so a uniquely-relevant baseline doc still
 * surfaces — just below the overlay's hits.
 *
 * The helper under test is `rerankOverlayFirst` in orchestrate.ts. We
 * exercise it via small synthetic corpora that mirror the contamination
 * shape from the issue: an overlay doc that scored just below a flood of
 * baseline hits should bubble to the top after re-ranking.
 *
 * The compile-then-import approach mirrors tokenize.test.mjs.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKERS_ROOT = join(__dirname, "..");
const SRC_DIR = join(WORKERS_ROOT, "src");

// Minimal harness: copy just the helper out of orchestrate.ts so we can
// compile it standalone without dragging in the full Worker dependency
// graph (env types, agents SDK, KV bindings, etc.).
const HARNESS_TS = `
export interface Entry { path: string; source: "canon" | "baseline"; }

export function rerankOverlayFirst(
  results: Array<{ id: string; score: number }>,
  entryMap: Map<string, Entry>,
): Array<{ id: string; score: number }> {
  return [...results].sort((a, b) => {
    const aSource = entryMap.get(a.id)?.source ?? "baseline";
    const bSource = entryMap.get(b.id)?.source ?? "baseline";
    if (aSource !== bSource) {
      return aSource === "canon" ? -1 : 1;
    }
    return b.score - a.score;
  });
}
`;

const tmp = mkdtempSync(join(tmpdir(), "oddkit-rerank-test-"));
const srcDir = join(tmp, "src");
const outDir = join(tmp, "out");
const { mkdirSync } = await import("node:fs");
mkdirSync(srcDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
const harnessPath = join(srcDir, "rerank.ts");
writeFileSync(harnessPath, HARNESS_TS);

const tsconfig = {
  compilerOptions: {
    target: "ES2022",
    module: "ES2022",
    moduleResolution: "bundler",
    lib: ["ES2022", "DOM"],
    types: [],
    strict: false,
    skipLibCheck: true,
    rootDir: srcDir,
    outDir,
  },
  include: [harnessPath],
};
const tsconfigPath = join(tmp, "tsconfig.json");
writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));

const tmpNodeModules = join(tmp, "node_modules");
if (!existsSync(tmpNodeModules)) {
  symlinkSync(join(WORKERS_ROOT, "node_modules"), tmpNodeModules);
}

// Verify the canonical helper text in orchestrate.ts matches the harness so
// that this test stays meaningful when the helper is edited.
const { readFileSync } = await import("node:fs");
const orchestrateSrc = readFileSync(join(SRC_DIR, "orchestrate.ts"), "utf8");
assert.ok(
  /function rerankOverlayFirst\(/.test(orchestrateSrc),
  "orchestrate.ts must export rerankOverlayFirst (otherwise this test is testing a stale shape)",
);
assert.ok(
  /aSource === "canon" \? -1 : 1/.test(orchestrateSrc),
  "orchestrate.ts rerankOverlayFirst must promote canon over baseline",
);

const compile = spawnSync("npx", ["--yes", "tsc", "-p", tsconfigPath], {
  encoding: "utf8",
});
if (compile.status !== 0) {
  console.error("TypeScript compile failed:");
  console.error(compile.stdout);
  console.error(compile.stderr);
  process.exit(1);
}

const compiledPath = join(outDir, "rerank.js");
const { rerankOverlayFirst } = await import(compiledPath);

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
    fail++;
  }
}

console.log("overlay-first re-rank unit tests");

await test("overlay hit bubbles above higher-scored baseline hits", async () => {
  // Mirrors issue #150 §1: baseline docs dominate BM25 even when an
  // overlay doc has the better answer. Pre-rerank order is BM25 score:
  // baseline:7, baseline:6, overlay:4.5, baseline:3.
  const entries = new Map([
    ["baseline/a", { path: "baseline/a", source: "baseline" }],
    ["baseline/b", { path: "baseline/b", source: "baseline" }],
    ["overlay/spec", { path: "overlay/spec", source: "canon" }],
    ["baseline/c", { path: "baseline/c", source: "baseline" }],
  ]);
  const input = [
    { id: "baseline/a", score: 7 },
    { id: "baseline/b", score: 6 },
    { id: "overlay/spec", score: 4.5 },
    { id: "baseline/c", score: 3 },
  ];
  const out = rerankOverlayFirst(input, entries);
  assert.equal(out[0].id, "overlay/spec", "overlay must rank first");
  assert.equal(out[1].id, "baseline/a", "baseline order preserved within tier");
  assert.equal(out[2].id, "baseline/b");
  assert.equal(out[3].id, "baseline/c");
});

await test("multiple overlay hits keep their BM25 order", async () => {
  const entries = new Map([
    ["overlay/a", { path: "overlay/a", source: "canon" }],
    ["overlay/b", { path: "overlay/b", source: "canon" }],
    ["baseline/x", { path: "baseline/x", source: "baseline" }],
  ]);
  const input = [
    { id: "baseline/x", score: 9 },
    { id: "overlay/a", score: 5 },
    { id: "overlay/b", score: 6 },
  ];
  const out = rerankOverlayFirst(input, entries);
  // Overlay tier first, ordered by score within: b (6) > a (5).
  assert.deepEqual(
    out.map((r) => r.id),
    ["overlay/b", "overlay/a", "baseline/x"],
  );
});

await test("baseline-only corpus is a no-op (preserves BM25 order)", async () => {
  const entries = new Map([
    ["baseline/a", { path: "baseline/a", source: "baseline" }],
    ["baseline/b", { path: "baseline/b", source: "baseline" }],
  ]);
  const input = [
    { id: "baseline/b", score: 8 },
    { id: "baseline/a", score: 4 },
  ];
  const out = rerankOverlayFirst(input, entries);
  assert.deepEqual(
    out.map((r) => r.id),
    ["baseline/b", "baseline/a"],
  );
});

await test("overlay-only corpus is a no-op (preserves BM25 order)", async () => {
  const entries = new Map([
    ["overlay/a", { path: "overlay/a", source: "canon" }],
    ["overlay/b", { path: "overlay/b", source: "canon" }],
  ]);
  const input = [
    { id: "overlay/a", score: 7 },
    { id: "overlay/b", score: 2 },
  ];
  const out = rerankOverlayFirst(input, entries);
  assert.deepEqual(
    out.map((r) => r.id),
    ["overlay/a", "overlay/b"],
  );
});

await test("missing entry is treated as baseline (defensive default)", async () => {
  const entries = new Map([
    ["overlay/spec", { path: "overlay/spec", source: "canon" }],
  ]);
  const input = [
    { id: "ghost", score: 99 },
    { id: "overlay/spec", score: 1 },
  ];
  const out = rerankOverlayFirst(input, entries);
  // Unknown entries default to baseline tier, so overlay/spec wins
  // despite the lower BM25 score. This protects against an entry being
  // deleted from the index between BM25 ranking and the re-rank step.
  assert.equal(out[0].id, "overlay/spec");
  assert.equal(out[1].id, "ghost");
});

await test("does not mutate the input array", async () => {
  const entries = new Map([
    ["overlay/a", { path: "overlay/a", source: "canon" }],
    ["baseline/x", { path: "baseline/x", source: "baseline" }],
  ]);
  const input = [
    { id: "baseline/x", score: 9 },
    { id: "overlay/a", score: 1 },
  ];
  const snapshot = input.map((r) => ({ ...r }));
  rerankOverlayFirst(input, entries);
  assert.deepEqual(input, snapshot, "input array must not be mutated");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
