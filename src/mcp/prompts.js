/**
 * MCP Prompts from Registry
 *
 * Loads prompts dynamically from the baseline's instruction registry.
 * Single source of truth: klappy.dev/canon/instructions/REGISTRY.json
 *
 * Also scans for standalone MCP prompt files in canon/prompts/ directory.
 * These prompt files define orchestration logic for epistemic guide tools.
 * Oddkit serves them as-is — it does not interpret or modify them.
 *
 * DRY: No content duplication - agents defined once in klappy.dev
 * KISS: Just reads files from cached baseline
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { join, basename } from "path";
import { ensureBaselineRepo } from "../baseline/ensureBaselineRepo.js";

let cachedRegistry = null;
let cachedBaselineRoot = null;
let cachedCanonPrompts = null;

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
 * Load standalone MCP prompt files from canon/prompts/ directory.
 * Each .md file becomes an MCP prompt. Supports optional YAML frontmatter
 * with fields: name, description, arguments.
 *
 * @returns {Promise<Array<{name: string, description: string, path: string}>>}
 */
async function loadCanonPrompts() {
  if (cachedCanonPrompts) {
    return cachedCanonPrompts;
  }

  const baseline = await ensureBaselineRepo();
  if (!baseline.root) {
    cachedCanonPrompts = [];
    return cachedCanonPrompts;
  }

  const promptsDir = join(baseline.root, "canon/prompts");
  if (!existsSync(promptsDir)) {
    cachedCanonPrompts = [];
    return cachedCanonPrompts;
  }

  try {
    const files = readdirSync(promptsDir).filter((f) => f.endsWith(".md"));
    cachedCanonPrompts = files.map((f) => {
      const filePath = join(promptsDir, f);
      const content = readFileSync(filePath, "utf-8");

      // Extract frontmatter if present
      let name = basename(f, ".md");
      let description = `Canon prompt: ${name}`;
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const fm = fmMatch[1];
        const nameMatch = fm.match(/^name:\s*(.+)$/m);
        const descMatch = fm.match(/^description:\s*(.+)$/m);
        if (nameMatch) name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
        if (descMatch) description = descMatch[1].trim().replace(/^["']|["']$/g, "");
      }

      return { name, description, path: filePath };
    });
    return cachedCanonPrompts;
  } catch (err) {
    console.error(`oddkit: failed to scan canon prompts: ${err.message}`);
    cachedCanonPrompts = [];
    return cachedCanonPrompts;
  }
}

/**
 * List all available prompts from registry + canon/prompts/ directory
 * @returns {Promise<Array<{name: string, description: string}>>}
 */
export async function listPrompts() {
  const prompts = [];

  // Load from registry (agent instructions)
  const { registry, error } = await loadRegistry();
  if (registry) {
    const registryPrompts = registry.instructions
      .filter((inst) => inst.audience === "agent" || inst.audience === "prompt")
      .map((inst) => ({
        name: inst.id,
        description: `Agent: ${inst.id} (${inst.uri})`,
      }));
    prompts.push(...registryPrompts);
  } else if (error) {
    console.error(`oddkit: failed to load registry: ${error}`);
  }

  // Load from canon/prompts/ directory
  const canonPrompts = await loadCanonPrompts();
  for (const cp of canonPrompts) {
    // Avoid duplicates (registry takes precedence)
    if (!prompts.some((p) => p.name === cp.name)) {
      prompts.push({ name: cp.name, description: cp.description });
    }
  }

  return prompts;
}

/**
 * Get a specific prompt by name.
 * Searches registry first, then canon/prompts/ directory.
 * @param {string} name - Prompt name (agent id from registry or canon prompt filename)
 * @returns {Promise<{description: string, messages: Array}>}
 */
export async function getPrompt(name) {
  // Try registry first
  const { registry, baselineRoot } = await loadRegistry();

  if (registry) {
    const instruction = registry.instructions.find((i) => i.id === name);
    if (instruction) {
      const agentPath = join(baselineRoot, instruction.path);
      if (existsSync(agentPath)) {
        try {
          const content = readFileSync(agentPath, "utf-8");
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
        }
      } else {
        console.error(`oddkit: agent file not found: ${agentPath}`);
      }
    }
  }

  // Try canon/prompts/ directory
  const canonPrompts = await loadCanonPrompts();
  const canonPrompt = canonPrompts.find((cp) => cp.name === name);
  if (canonPrompt) {
    try {
      const content = readFileSync(canonPrompt.path, "utf-8");
      const contentWithoutFrontmatter = content.replace(/^---[\s\S]*?---\n/, "");

      return {
        description: canonPrompt.description,
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
      console.error(`oddkit: failed to read canon prompt: ${err.message}`);
    }
  }

  return null;
}

/**
 * Invalidate prompt caches (for testing or baseline updates)
 */
export function invalidatePromptCache() {
  cachedRegistry = null;
  cachedBaselineRoot = null;
  cachedCanonPrompts = null;
}
