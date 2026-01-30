import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { normalizeRef } from "../utils/normalizeRef.js";

function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    return null;
  }
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 8);
}

function resolveInstructionPath(instruction, baselineRoot, repoRoot) {
  const { path, owner } = instruction;

  if (!path || typeof path !== "string") {
    throw new Error(`Instruction missing valid path: ${JSON.stringify(instruction)}`);
  }

  switch (owner) {
    case "klappy.dev":
      if (!baselineRoot)
        throw new Error(`Missing baseline_root (required to resolve klappy.dev owner)`);
      return join(baselineRoot, path);
    case "oddkit":
      return join(repoRoot, path);
    default:
      throw new Error(`Unknown owner: ${owner}. Must be "klappy.dev" or "oddkit".`);
  }
}

function resolveDepPath(normalizedRef, baselineRoot, repoRoot) {
  function resolveWithExtension(root, relativePath) {
    const filename = relativePath.split("/").pop();
    const hasExtension = /\.[a-zA-Z0-9]+$/.test(filename);

    if (hasExtension) {
      const fullPath = join(root, relativePath);
      if (existsSync(fullPath)) return fullPath;
      throw new Error(`Not found: ${relativePath}`);
    }

    const mdPath = join(root, relativePath + ".md");
    if (existsSync(mdPath)) return mdPath;

    const plainPath = join(root, relativePath);
    if (existsSync(plainPath)) return plainPath;

    throw new Error(`Not found: ${relativePath} (tried .md and extensionless)`);
  }

  if (normalizedRef.startsWith("klappy://")) {
    if (!baselineRoot) throw new Error("Missing baseline_root for klappy:// ref resolution");
    const relativePath = normalizedRef.replace("klappy://", "");
    return resolveWithExtension(baselineRoot, relativePath);
  }

  if (normalizedRef.startsWith("oddkit://")) {
    const relativePath = normalizedRef.replace("oddkit://", "");
    return resolveWithExtension(repoRoot, relativePath);
  }

  throw new Error(`Unknown protocol in ref: ${normalizedRef}`);
}

function classifyByType(type, _content) {
  // v1: conservative default, no previous content diffs stored
  switch (type) {
    case "tool_schema":
    case "charter":
    case "canon_doc":
    case "instruction":
    default:
      return { level: "should_update", summary: "dependency content changed", action: "review" };
  }
}

function buildPatchPlan(impact) {
  // v1: simple deterministic patch plan structure
  // (No auto edits. Just actionable list grouped by severity.)
  return {
    must_update: impact.must_update.map((x) => ({
      instruction_id: x.id,
      reason: x.change_summary,
      dependency: x.dependency,
      suggested_action: x.suggested_action,
    })),
    should_update: impact.should_update.map((x) => ({
      instruction_id: x.id,
      reason: x.change_summary,
      dependency: x.dependency,
      suggested_action: x.suggested_action,
    })),
    nice_to_update: impact.nice_to_update.map((x) => ({
      instruction_id: x.id,
      reason: x.change_summary,
      dependency: x.dependency,
      suggested_action: x.suggested_action,
    })),
    errors: impact.errors,
  };
}

/**
 * Run instruction sync.
 * Inputs:
 * - repoRoot: oddkit repo root
 * - baselineRoot: klappy.dev root (filesystem mode)
 * - registryPayload/statePayload: payload mode
 *
 * Output:
 * - impact sets
 * - patch plan
 * - updated state (sorted keys, unresolved list)
 */
export async function runInstructionSync({
  repoRoot = ".",
  baselineRoot,
  registryPayload,
  statePayload,
}) {
  const nowIso = new Date().toISOString();

  const registry =
    registryPayload || loadJson(join(baselineRoot, "canon/instructions/REGISTRY.json"));

  if (!registry || !Array.isArray(registry.instructions)) {
    throw new Error(
      "instruction_sync: registry missing or invalid (must contain instructions array)",
    );
  }

  const defaultState = {
    schema_version: "1.0.0",
    last_sync: null,
    dependency_hashes: {},
    unresolved: [],
  };

  const state =
    statePayload ||
    loadJson(join(baselineRoot, "canon/instructions/REGISTRY.state.json")) ||
    defaultState;

  const impactSet = {
    must_update: [],
    should_update: [],
    nice_to_update: [],
    errors: [],
  };

  const newHashes = { ...(state.dependency_hashes || {}) }; // V1 does not prune
  const unresolved = [];

  for (const instruction of registry.instructions) {
    // Ensure instruction file exists
    let instructionPath;
    try {
      instructionPath = resolveInstructionPath(instruction, baselineRoot, repoRoot);
    } catch (e) {
      impactSet.errors.push({
        id: instruction?.id ?? "(unknown)",
        reason: "INSTRUCTION_RESOLVE_ERROR",
        detail: e.message,
      });
      continue;
    }

    if (!existsSync(instructionPath)) {
      impactSet.errors.push({
        id: instruction.id,
        reason: "FILE_MISSING",
        path: instruction.path,
      });
      continue;
    }

    for (const dep of instruction.depends_on || []) {
      const { ref, type } = dep;

      let normalizedRef;
      try {
        normalizedRef = normalizeRef(ref);
      } catch (e) {
        unresolved.push({ ref: String(ref), reason: e.message });
        continue;
      }

      let depPath;
      try {
        depPath = resolveDepPath(normalizedRef, baselineRoot, repoRoot);
      } catch (e) {
        unresolved.push({ ref: normalizedRef, reason: e.message });
        continue;
      }

      let bytes;
      try {
        bytes = readFileSync(depPath);
      } catch (e) {
        unresolved.push({ ref: normalizedRef, reason: `Cannot read: ${e.message}` });
        continue;
      }

      const currentHash = hashBytes(bytes);
      const lastKnownHash = (state.dependency_hashes || {})[normalizedRef];

      newHashes[normalizedRef] = currentHash;

      if (currentHash !== lastKnownHash) {
        const depContent = bytes.toString("utf-8");
        const impact = classifyByType(type, depContent);

        impactSet[impact.level].push({
          id: instruction.id,
          dependency: normalizedRef,
          type,
          change_summary: impact.summary,
          suggested_action: impact.action,
        });
      }
    }
  }

  const sortedHashes = Object.keys(newHashes)
    .sort()
    .reduce((acc, k) => {
      acc[k] = newHashes[k];
      return acc;
    }, {});

  return {
    timestamp: nowIso,
    registry_version: registry.version,
    impact: impactSet,
    patch_plan: buildPatchPlan(impactSet),
    updated_state: {
      schema_version: state.schema_version || "1.0.0",
      last_sync: nowIso,
      dependency_hashes: sortedHashes,
      unresolved,
    },
  };
}

export const __internal = {
  resolveInstructionPath,
  resolveDepPath,
  hashBytes,
};
