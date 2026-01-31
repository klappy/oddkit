// drift-audit/scripts/check-index.mjs
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const indexPath = join(homedir(), ".oddkit/cache/klappy.dev/main/.oddkit/index.json");

let idx;
try {
  idx = JSON.parse(readFileSync(indexPath, "utf-8"));
} catch (err) {
  console.error("Could not read index:", err.message);
  process.exit(1);
}

console.log("=== Index Stats ===");
console.log(JSON.stringify(idx.stats, null, 2));

console.log("\n=== Epoch 4 docs ===");
const e4docs = idx.documents.filter(
  (d) =>
    d.path.includes("epistemic-architecture") ||
    d.path.includes("epistemic-contract") ||
    d.path.includes("defaults/"),
);
console.log("Found", e4docs.length, "Epoch 4 docs:");
e4docs.forEach((d) => console.log(" -", d.path));

console.log("\n=== Apocrypha docs (SHOULD BE EMPTY) ===");
const apocrypha = idx.documents.filter((d) => d.path.includes("apocrypha"));
if (apocrypha.length === 0) {
  console.log("PASS: No apocrypha docs in index");
} else {
  console.log("FAIL: Found", apocrypha.length, "apocrypha docs (should be excluded):");
  apocrypha.forEach((d) => console.log(" -", d.path));
}
