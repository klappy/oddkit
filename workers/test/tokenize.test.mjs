#!/usr/bin/env node
/**
 * Unit test for workers/src/tokenize.ts.
 *
 * Compiles tokenize.ts via tsc into a temp dir, then dynamic-imports the
 * compiled .js. The compile step exercises the same TypeScript surface
 * that ships in the worker bundle.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKERS_ROOT = join(__dirname, "..");
const TOKENIZE_TS = join(WORKERS_ROOT, "src", "tokenize.ts");

const tmp = mkdtempSync(join(tmpdir(), "oddkit-tokenize-test-"));
const tsconfig = {
  compilerOptions: {
    target: "ES2022",
    module: "ES2022",
    moduleResolution: "bundler",
    lib: ["ES2022", "DOM"],
    types: [],
    strict: false,
    skipLibCheck: true,
    resolveJsonModule: true,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    rootDir: join(WORKERS_ROOT, "src"),
    outDir: tmp,
  },
  include: [TOKENIZE_TS],
};
const tsconfigPath = join(tmp, "tsconfig.json");
writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));

const tmpNodeModules = join(tmp, "node_modules");
if (!existsSync(tmpNodeModules)) {
  symlinkSync(join(WORKERS_ROOT, "node_modules"), tmpNodeModules);
}

const compile = spawnSync("npx", ["--yes", "tsc", "-p", tsconfigPath], {
  encoding: "utf8",
});
if (compile.status !== 0) {
  console.error("TypeScript compile failed:");
  console.error(compile.stdout);
  console.error(compile.stderr);
  process.exit(1);
}

const compiledPath = join(tmp, "tokenize.js");
const { countTokensSafe, measurePayloadShape } = await import(compiledPath);

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

console.log("tokenize.ts unit tests");

await test("countTokensSafe returns 0 for empty string", async () => {
  const n = await countTokensSafe("");
  assert.equal(n, 0);
});

await test("countTokensSafe returns a positive integer for normal text", async () => {
  const n = await countTokensSafe("hello world this is a test");
  assert.equal(typeof n, "number");
  assert.ok(n > 0, `expected > 0, got ${n}`);
  assert.equal(n, Math.floor(n), "must be an integer");
});

await test("countTokensSafe scales with text length", async () => {
  const small = await countTokensSafe("hello world");
  const big = await countTokensSafe("hello world ".repeat(100));
  assert.ok(big > small * 50, `big (${big}) should be much larger than small (${small})`);
});

await test("measurePayloadShape returns all required fields as numbers", async () => {
  const s = await measurePayloadShape("request", "response");
  for (const field of ["bytes_in", "bytes_out", "tokens_in", "tokens_out", "tokenize_ms"]) {
    assert.ok(field in s, `missing field: ${field}`);
    assert.equal(typeof s[field], "number", `${field} must be number, got ${typeof s[field]}`);
  }
});

await test("measurePayloadShape bytes match UTF-8 byte length", async () => {
  const req = "hello"; // 5 bytes
  const res = "caf\u00e9"; // 4 chars, 5 UTF-8 bytes (\u00e9 = 2 bytes)
  const s = await measurePayloadShape(req, res);
  assert.equal(s.bytes_in, 5, `bytes_in: expected 5, got ${s.bytes_in}`);
  assert.equal(s.bytes_out, 5, `bytes_out: expected 5, got ${s.bytes_out}`);
});

await test("measurePayloadShape produces positive token counts for non-empty input", async () => {
  const s = await measurePayloadShape(
    JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 1 }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
  );
  assert.ok(s.tokens_in > 0, "tokens_in should be > 0");
  assert.ok(s.tokens_out > 0, "tokens_out should be > 0");
});

await test("measurePayloadShape tokenize_ms is non-negative and finite", async () => {
  const s = await measurePayloadShape("a", "b");
  assert.ok(s.tokenize_ms >= 0, "tokenize_ms must be >= 0");
  assert.ok(Number.isFinite(s.tokenize_ms), "tokenize_ms must be finite");
});

await test("measurePayloadShape handles empty response (SSE skipped)", async () => {
  const s = await measurePayloadShape("hello", "");
  assert.equal(s.bytes_out, 0);
  assert.equal(s.tokens_out, 0);
  assert.ok(s.bytes_in > 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
