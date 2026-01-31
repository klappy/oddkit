// src/audit/runTests.js
import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

/**
 * Canonical test list for epoch audits.
 * Order matters: stateful tests run last to avoid contamination.
 * Tests are run SERIALLY to prevent race conditions.
 */
const AUDIT_TEST_LIST = [
  // Core functionality (stateless)
  { name: "smoke", cmd: "npm test", description: "Core CLI: index, librarian, validate, explain" },
  { name: "mcp", cmd: "npm run test:mcp", description: "MCP server boot" },
  { name: "tooljson", cmd: "npm run test:tooljson", description: "Tool JSON contract" },
  {
    name: "antifragile",
    cmd: "npm run test:antifragile",
    description: "Orchestrator antifragile behavior",
  },
  { name: "catalog", cmd: "npm run test:catalog", description: "Catalog action routing" },
  {
    name: "policy",
    cmd: "npm run test:policy",
    description: "Policy tools (canonTarget, docFetch)",
  },

  // Integration tests
  {
    name: "adversarial",
    cmd: "bash tests/adversarial.sh",
    description: "Relevance arbitration, URI collisions, drift detection",
  },
  {
    name: "mcp-instructions",
    cmd: "bash tests/mcp-instructions-smoke.sh",
    description: "MCP instructions contract",
  },
  { name: "mcp-prompts", cmd: "bash tests/mcp-prompts-smoke.sh", description: "MCP prompts" },
  {
    name: "mcp-orchestrate",
    cmd: "bash tests/mcp-orchestrate-test.sh",
    description: "Orchestrate citations",
  },
  {
    name: "instruction-sync",
    cmd: "bash tests/orchestrate-instruction-sync.test.sh",
    description: "Instruction sync routing",
  },
  {
    name: "sync-agents",
    cmd: "bash tests/sync-agents.test.sh",
    description: "Sync-agents command",
  },

  // Containment tests (Epoch 4 specific)
  {
    name: "noindex-exclusion",
    cmd: "bash tests/noindex-exclusion.test.sh",
    description: ".noindex epistemic exclusion",
  },
  {
    name: "odd-uri-scheme",
    cmd: "bash tests/odd-uri-scheme.test.sh",
    description: "odd:// URI containment",
  },

  // Stateful tests (run last - they write to shared state)
  { name: "preflight", cmd: "npm run test:preflight", description: "Preflight action routing" },
];

/**
 * Run all audit tests serially.
 * Returns detailed results for each test.
 */
export async function runAuditTests(options = {}) {
  const { verbose = false, cwd = process.cwd() } = options;
  const results = [];
  let passCount = 0;
  let failCount = 0;

  for (const test of AUDIT_TEST_LIST) {
    const start = Date.now();
    let passed = false;
    let output = "";
    let error = null;

    try {
      output = execSync(test.cmd, {
        cwd,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 120000, // 2 minute timeout per test
      });
      passed = true;
      passCount++;
    } catch (err) {
      passed = false;
      failCount++;
      error = err.message;
      output = err.stdout || err.stderr || "";
    }

    const duration = Date.now() - start;

    results.push({
      name: test.name,
      description: test.description,
      cmd: test.cmd,
      passed,
      duration,
      output: verbose ? output : null,
      error,
    });

    if (verbose) {
      const status = passed ? "PASS" : "FAIL";
      console.error(`  [${status}] ${test.name} (${duration}ms)`);
    }
  }

  return {
    total: AUDIT_TEST_LIST.length,
    passed: passCount,
    failed: failCount,
    allPassed: failCount === 0,
    results,
  };
}

/**
 * Get the canonical test list (for documentation/receipts)
 */
export function getTestList() {
  return AUDIT_TEST_LIST.map((t) => ({
    name: t.name,
    description: t.description,
  }));
}
