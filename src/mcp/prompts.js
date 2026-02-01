/**
 * MCP Prompts from Registry
 *
 * Loads prompts dynamically from the baseline's instruction registry.
 * Single source of truth: klappy.dev/canon/instructions/REGISTRY.json
 *
 * DRY: No content duplication - agents defined once in klappy.dev
 * KISS: Just reads files from cached baseline
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { ensureBaselineRepo } from "../baseline/ensureBaselineRepo.js";

let cachedRegistry = null;
let cachedBaselineRoot = null;

/**
 * Load registry from baseline (cached)
 */
async function loadRegistry() {
  if (cachedRegistry && cachedBaselineRoot) {
    return { registry: cachedRegistry, baselineRoot: cachedBaselineRoot };
  }

  const baseline = await ensureBaselineRepo();
  if (!baseline.root) {
    return { registry: null, baselineRoot: null, error: baseline.error };
  }

  const registryPath = join(baseline.root, "canon/instructions/REGISTRY.json");
  if (!existsSync(registryPath)) {
    return { registry: null, baselineRoot: baseline.root, error: "Registry not found" };
  }

  try {
    cachedRegistry = JSON.parse(readFileSync(registryPath, "utf-8"));
    cachedBaselineRoot = baseline.root;
    return { registry: cachedRegistry, baselineRoot: baseline.root };
  } catch (err) {
    return { registry: null, baselineRoot: baseline.root, error: err.message };
  }
}

/**
 * List all available prompts from registry
 * @returns {Promise<Array<{name: string, description: string}>>}
 */
export async function listPrompts() {
  const { registry, error } = await loadRegistry();

  if (!registry) {
    console.error(`oddkit: failed to load registry: ${error}`);
    return [];
  }

  return registry.instructions
    .filter((inst) => inst.audience === "agent")
    .map((inst) => ({
      name: inst.id,
      description: `Agent: ${inst.id} (${inst.uri})`,
    }));
}

/**
 * Get a specific prompt by name
 * @param {string} name - Prompt name (agent id from registry)
 * @returns {Promise<{description: string, messages: Array}>}
 */
export async function getPrompt(name) {
  const { registry, baselineRoot } = await loadRegistry();

  if (!registry) {
    return null;
  }

  const instruction = registry.instructions.find((i) => i.id === name);
  if (!instruction) {
    return null;
  }

  const agentPath = join(baselineRoot, instruction.path);
  if (!existsSync(agentPath)) {
    console.error(`oddkit: agent file not found: ${agentPath}`);
    return null;
  }

  try {
    const content = readFileSync(agentPath, "utf-8");

    // Strip YAML frontmatter if present
    const contentWithoutFrontmatter = content.replace(/^---[\s\S]*?---\n/, "");

    return {
      description: `Agent: ${instruction.id}`,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: contentWithoutFrontmatter.trim(),
          },
        },
      ],
    };
  } catch (err) {
    console.error(`oddkit: failed to read agent: ${err.message}`);
    return null;
  }
}
