/**
 * CI script: verify the creed in AGENTS.md and chat-api.ts matches canon.
 *
 * Reads canon/values/orientation.md from baseline, extracts the creed,
 * and checks it appears verbatim in both consumer files.
 *
 * Exit 0 = fresh, Exit 1 = drift detected.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { ensureBaselineRepo } from "../src/baseline/ensureBaselineRepo.js";

const REPO_ROOT = process.cwd();

function extractCreed(content) {
  const lines = content.split("\n");
  const startIdx = lines.findIndex((l) => /^##\s+The Creed/.test(l));
  if (startIdx === -1) return null;
  const creedLines = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    const trimmed = lines[i].trim();
    if (trimmed && !trimmed.startsWith(">") && !trimmed.startsWith("#") && !trimmed.startsWith("<!--") && !/^-{3,}$/.test(trimmed)) {
      creedLines.push(trimmed);
    }
  }
  return creedLines.length > 0 ? creedLines : null;
}

async function main() {
  console.log("Checking creed freshness against canon...\n");

  // 1. Fetch baseline
  const baseline = await ensureBaselineRepo();
  if (!baseline.root) {
    console.error("FAIL: Could not fetch baseline repo");
    process.exit(1);
  }

  // 2. Extract creed from canon
  const orientPath = join(baseline.root, "canon", "values", "orientation.md");
  if (!existsSync(orientPath)) {
    console.error("FAIL: canon/values/orientation.md not found in baseline");
    process.exit(1);
  }
  const orientContent = readFileSync(orientPath, "utf-8");
  const creed = extractCreed(orientContent);
  if (!creed || creed.length === 0) {
    console.error("FAIL: Could not extract creed from orientation.md (missing ## The Creed section)");
    process.exit(1);
  }
  console.log(`Canon creed (${creed.length} lines):`);
  for (const line of creed) console.log(`  ${line}`);
  console.log();

  let failures = 0;

  // 3. Check AGENTS.md
  const agentsPath = join(REPO_ROOT, "AGENTS.md");
  if (!existsSync(agentsPath)) {
    console.error("FAIL: AGENTS.md not found");
    failures++;
  } else {
    const agentsContent = readFileSync(agentsPath, "utf-8");
    const missing = creed.filter((line) => !agentsContent.includes(line));
    if (missing.length > 0) {
      console.error("FAIL: AGENTS.md is missing creed lines:");
      for (const line of missing) console.error(`  - ${line}`);
      failures++;
    } else {
      console.log("OK: AGENTS.md contains all creed lines");
    }
  }

  // 4. Check workers/src/chat-api.ts
  const chatApiPath = join(REPO_ROOT, "workers", "src", "chat-api.ts");
  if (!existsSync(chatApiPath)) {
    console.error("FAIL: workers/src/chat-api.ts not found");
    failures++;
  } else {
    const chatApiContent = readFileSync(chatApiPath, "utf-8");
    const missing = creed.filter((line) => !chatApiContent.includes(line));
    if (missing.length > 0) {
      console.error("FAIL: workers/src/chat-api.ts is missing creed lines:");
      for (const line of missing) console.error(`  - ${line}`);
      failures++;
    } else {
      console.log("OK: workers/src/chat-api.ts contains all creed lines");
    }
  }

  console.log();
  if (failures > 0) {
    console.error(`FAILED: ${failures} file(s) have stale creed. Update them to match canon.`);
    process.exit(1);
  } else {
    console.log("PASSED: Creed is fresh in all consumer files.");
  }
}

main().catch((err) => {
  console.error("Script error:", err.message);
  process.exit(1);
});
