// src/audit/auditEpoch.js
import { rmSync, existsSync, mkdtempSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";
import { runAuditTests, getTestList } from "./runTests.js";
import { runAuditProbes } from "./probes.js";
import { generateReceipt, writeReceipts, getOddkitCommit, isOddkitDirty } from "./receipt.js";
import { ensureBaselineRepo, getCacheDir } from "../baseline/ensureBaselineRepo.js";
import { resolveCanonTarget } from "../policy/canonTarget.js";

const DEFAULT_BASELINE_URL = "https://github.com/klappy/klappy.dev.git";

/**
 * Run a full epoch compatibility audit.
 *
 * Pipeline:
 * 1. Resolve baseline ref → commit
 * 2. Optional cache purge (--fresh)
 * 3. Baseline pull
 * 4. Run tests serially
 * 5. Run integration probes
 * 6. Emit receipt (markdown + json)
 * 7. Return verdict
 */
export async function runAuditEpoch(options = {}) {
  const {
    baseline = DEFAULT_BASELINE_URL,
    ref = "main",
    fresh = false,
    ci = false,
    verbose = !ci,
    repoRoot = process.cwd(),
  } = options;

  const startTime = Date.now();
  const auditDate = new Date().toISOString();

  // State isolation: create temp state dir for audit mode
  // This prevents cross-test contamination of last.json
  const stateDir = mkdtempSync(join(tmpdir(), "oddkit-audit-"));
  process.env.ODDKIT_STATE_DIR = stateDir;

  // Crash-safe cleanup: ensure temp dir is removed on exit/interrupt
  const cleanup = () => {
    try {
      rmSync(stateDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    delete process.env.ODDKIT_STATE_DIR;
  };

  const handleSignal = (signal) => {
    cleanup();
    process.exit(128 + (signal === "SIGINT" ? 2 : 15));
  };

  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));

  try {
    if (verbose) {
      console.error("=== Epoch Compatibility Audit ===");
      console.error(`Baseline: ${baseline}`);
      console.error(`Ref: ${ref}`);
      console.error(`Fresh: ${fresh}`);
      console.error(`State Dir: ${stateDir}`);
      console.error("");
    }

    // Track cache state
    const cachePath = getCacheDir(baseline, ref);
    let cachePurged = false;

    // Step 1: Optional cache purge
    if (fresh) {
      if (verbose) console.error("Purging baseline cache...");
      purgeBaselineCache(baseline, ref);
      cachePurged = true;
    }

    // Step 2: Ensure baseline is available
    if (verbose) console.error("Ensuring baseline is available...");
    // ensureBaselineRepo expects a string (URL) or null for default
    // Ref is controlled by ODDKIT_BASELINE_REF env var
    const prevRef = process.env.ODDKIT_BASELINE_REF;
    process.env.ODDKIT_BASELINE_REF = ref;

    const baselineResult = await ensureBaselineRepo(baseline);

    // Restore previous ref
    if (prevRef !== undefined) {
      process.env.ODDKIT_BASELINE_REF = prevRef;
    } else {
      delete process.env.ODDKIT_BASELINE_REF;
    }

    if (!baselineResult.root) {
      throw new Error(`Failed to fetch baseline: ${baselineResult.error}`);
    }

    // Step 3: Resolve canon target
    const canonTarget = await resolveCanonTarget();
    const baselineCommit = canonTarget.commitFull || canonTarget.commit;

    if (verbose) {
      console.error(`Baseline commit: ${baselineCommit}`);
      console.error("");
    }

    // Step 4: Run tests serially
    if (verbose) console.error("Running tests (serial)...");
    const testResults = await runAuditTests({ verbose, cwd: repoRoot });

    if (verbose) {
      console.error(`Tests: ${testResults.passed}/${testResults.total} passed`);
      console.error("");
    }

    // Step 5: Run integration probes
    if (verbose) console.error("Running integration probes...");
    const probeResults = await runAuditProbes({ repoRoot, verbose });

    if (verbose) {
      console.error(`Probes: ${probeResults.passed}/${probeResults.total} passed`);
      console.error("");
    }

    // Step 6: Generate receipt
    const oddkitCommit = getOddkitCommit(repoRoot);
    const oddkitDirty = isOddkitDirty(repoRoot);
    const { json, markdown, verdict } = generateReceipt({
      repoRoot,
      baselineUrl: baseline,
      baselineRef: ref,
      baselineCommit,
      oddkitCommit,
      oddkitDirty,
      cacheFresh: fresh,
      cachePath,
      cachePurged,
      testResults,
      probeResults,
      auditDate,
    });

    // Step 7: Write receipts
    const receipts = writeReceipts({ repoRoot, json, markdown });

    const duration = Date.now() - startTime;

    if (verbose) {
      console.error("=== Audit Complete ===");
      console.error(`Verdict: ${verdict}`);
      console.error(`Duration: ${duration}ms`);
      console.error(`Receipt: ${receipts.latest_md}`);
      console.error("");
    }

    return {
      verdict,
      compatible: verdict === "COMPATIBLE",
      duration,
      baseline: {
        url: baseline,
        ref,
        commit: baselineCommit,
      },
      tests: {
        total: testResults.total,
        passed: testResults.passed,
        failed: testResults.failed,
      },
      probes: {
        total: probeResults.total,
        passed: probeResults.passed,
        failed: probeResults.failed,
      },
      receipts,
      json,
    };
  } finally {
    // Crash-safe cleanup: always runs, even on error/interrupt
    cleanup();
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
  }
}

/**
 * Purge the baseline cache for a specific ref.
 */
function purgeBaselineCache(baselineUrl, ref) {
  // Extract repo name from URL
  const repoName = baselineUrl.split("/").pop()?.replace(".git", "") || "baseline";
  const cacheDir = join(homedir(), ".oddkit", "cache", repoName, ref);

  if (existsSync(cacheDir)) {
    rmSync(cacheDir, { recursive: true, force: true });
  }

  // Also purge the index cache
  const indexCache = join(homedir(), ".oddkit", "cache", "indexes", `${repoName}-${ref}.json`);
  if (existsSync(indexCache)) {
    rmSync(indexCache, { force: true });
  }
}

/**
 * Get the canonical test list for documentation.
 */
export { getTestList };
