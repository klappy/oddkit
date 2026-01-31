// src/audit/receipt.js
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { execSync } from "child_process";
import { createHash } from "crypto";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACT_PATH = join(__dirname, "COMPATIBILITY-CONTRACT.md");
const CONTRACT_VERSION = "1.0.0";

/**
 * Generate audit receipt in both markdown and JSON formats.
 * Receipts are machine-generated and commit-bound.
 */
export function generateReceipt(options) {
  const {
    repoRoot,
    baselineUrl,
    baselineRef,
    baselineCommit,
    oddkitCommit,
    oddkitDirty = false,
    cacheFresh,
    cachePath = null,
    cachePurged = false,
    testResults,
    probeResults,
    auditDate = new Date().toISOString(),
  } = options;

  const verdict = testResults.allPassed && probeResults.allPassed ? "COMPATIBLE" : "INCOMPATIBLE";
  const contractHash = getContractHash();

  const json = {
    schema_version: "1.0.0",
    verdict,
    audit_date: auditDate,
    oddkit: {
      commit: oddkitCommit,
      dirty: oddkitDirty,
    },
    baseline: {
      url: baselineUrl,
      ref: baselineRef,
      commit: baselineCommit,
    },
    cache: {
      fresh: cacheFresh,
      path: cachePath,
      purged: cachePurged,
    },
    contract: {
      version: CONTRACT_VERSION,
      sha256: contractHash,
      path: "src/audit/COMPATIBILITY-CONTRACT.md",
    },
    tests: {
      total: testResults.total,
      passed: testResults.passed,
      failed: testResults.failed,
      ordered: true,
      results: testResults.results.map((r) => ({
        name: r.name,
        description: r.description,
        passed: r.passed,
        duration: r.duration,
        error: r.error || null,
      })),
    },
    probes: {
      total: probeResults.total,
      passed: probeResults.passed,
      failed: probeResults.failed,
      results: probeResults.probes.map((p) => ({
        name: p.name,
        passed: p.passed,
        data: p.data,
        error: p.error || null,
      })),
    },
  };

  const markdown = renderMarkdown(json);

  return { json, markdown, verdict };
}

/**
 * Get SHA256 hash of the compatibility contract (first 8 chars).
 */
function getContractHash() {
  try {
    const content = readFileSync(CONTRACT_PATH, "utf8");
    const hash = createHash("sha256").update(content).digest("hex");
    return hash.slice(0, 8);
  } catch {
    return "unknown";
  }
}

/**
 * Write receipts to disk.
 */
export function writeReceipts(options) {
  const { repoRoot, json, markdown } = options;

  const auditDir = join(repoRoot, "drift-audit");
  if (!existsSync(auditDir)) {
    mkdirSync(auditDir, { recursive: true });
  }

  // Always overwrite LATEST
  const latestMd = join(auditDir, "EPOCH-AUDIT-LATEST.md");
  const latestJson = join(auditDir, "EPOCH-AUDIT-LATEST.json");

  writeFileSync(latestMd, markdown, "utf8");
  writeFileSync(latestJson, JSON.stringify(json, null, 2), "utf8");

  // Also write timestamped version for history
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const timestampedJson = join(auditDir, `EPOCH-AUDIT-${timestamp}.json`);
  writeFileSync(timestampedJson, JSON.stringify(json, null, 2), "utf8");

  return {
    latest_md: latestMd,
    latest_json: latestJson,
    timestamped_json: timestampedJson,
  };
}

/**
 * Get current oddkit commit hash and dirty state.
 */
export function getOddkitCommit(repoRoot) {
  try {
    const commit = execSync("git rev-parse HEAD", {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    return commit;
  } catch {
    return "unknown";
  }
}

/**
 * Check if oddkit repo has uncommitted changes.
 */
export function isOddkitDirty(repoRoot) {
  try {
    const status = execSync("git status --porcelain", {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    return status.length > 0;
  } catch {
    return false;
  }
}

function renderMarkdown(json) {
  const lines = [];

  lines.push("# Epoch Compatibility Audit");
  lines.push("");
  lines.push(`> Machine-generated receipt. Do not hand-edit.`);
  lines.push("");
  lines.push(`**Verdict:** ${json.verdict}`);
  lines.push("");
  lines.push("## Audit Context");
  lines.push("");
  lines.push(`| Field | Value |`);
  lines.push(`|-------|-------|`);
  lines.push(`| Audited Repo | oddkit |`);
  lines.push(`| oddkit Commit | \`${json.oddkit.commit}\` |`);
  lines.push(`| oddkit Dirty | ${json.oddkit.dirty} |`);
  lines.push(`| Baseline URL | ${json.baseline.url} |`);
  lines.push(`| Baseline Ref | ${json.baseline.ref} |`);
  lines.push(`| Baseline Commit | \`${json.baseline.commit}\` |`);
  lines.push(`| Cache Fresh | ${json.cache.fresh} |`);
  lines.push(`| Cache Purged | ${json.cache.purged} |`);
  lines.push(`| Contract Version | ${json.contract.version} |`);
  lines.push(`| Contract SHA256 | \`${json.contract.sha256}\` |`);
  lines.push(`| Audit Date | ${json.audit_date} |`);
  lines.push("");

  lines.push("## Test Results");
  lines.push("");
  lines.push(
    `**Total:** ${json.tests.total} | **Passed:** ${json.tests.passed} | **Failed:** ${json.tests.failed}`,
  );
  lines.push("");
  lines.push("| Test | Status | Duration |");
  lines.push("|------|--------|----------|");
  for (const t of json.tests.results) {
    const status = t.passed ? "PASS" : "FAIL";
    const duration = t.duration ? `${t.duration}ms` : "-";
    lines.push(`| ${t.name} | ${status} | ${duration} |`);
  }
  lines.push("");

  lines.push("## Integration Probes");
  lines.push("");
  lines.push(
    `**Total:** ${json.probes.total} | **Passed:** ${json.probes.passed} | **Failed:** ${json.probes.failed}`,
  );
  lines.push("");
  lines.push("| Probe | Status |");
  lines.push("|-------|--------|");
  for (const p of json.probes.results) {
    const status = p.passed ? "PASS" : "FAIL";
    lines.push(`| ${p.name} | ${status} |`);
  }
  lines.push("");

  // Index stats if available
  const indexProbe = json.probes.results.find((p) => p.name === "index_merge");
  if (indexProbe?.data) {
    lines.push("## Index Stats");
    lines.push("");
    lines.push("| Metric | Value |");
    lines.push("|--------|-------|");
    lines.push(`| Total docs | ${indexProbe.data.total} |`);
    lines.push(`| Local | ${indexProbe.data.local} |`);
    lines.push(`| Baseline | ${indexProbe.data.baseline} |`);
    lines.push(`| Excluded by .noindex | ${indexProbe.data.excluded_by_noindex} |`);
    lines.push(`| Governing | ${indexProbe.data.governing} |`);
    lines.push(`| Operational | ${indexProbe.data.operational} |`);
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(`*Generated by \`oddkit audit epoch\` at ${json.audit_date}*`);

  return lines.join("\n");
}
