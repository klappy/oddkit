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
import { ensureBaselineRepo, getSessionSha } from "../baseline/ensureBaselineRepo.js";

// ──────────────────────────────────────────────────────────────────────────────
// SHA-keyed prompt caches
//
// Content-addressed: cached data is keyed to the baseline commit SHA.
// When the SHA changes (new baseline commit), caches are automatically
// invalidated by identity mismatch — no TTL, no manual flush.
// ──────────────────────────────────────────────────────────────────────────────
let cachedRegistry = null;
let cachedBaselineRoot = null;
let cachedCanonPrompts = null;
let cachedPromptsSha = null;

/**
 * Load registry from baseline (SHA-keyed cache)
 */
async function loadRegistry() {
  const currentSha = getSessionSha();

  // Content-addressed cache check: if SHA matches, data is truthful
  if (cachedRegistry && cachedBaselineRoot && cachedPromptsSha === currentSha && currentSha) {
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
    cachedPromptsSha = baseline.commitSha || currentSha;
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
  const currentSha = getSessionSha();

  // Content-addressed: return cached prompts only if SHA matches
  if (cachedCanonPrompts && cachedPromptsSha === currentSha && currentSha) {
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
 * Clear prompt caches (storage hygiene only).
 *
 * NOT required for correctness — content-addressed caching ensures
 * fresh content is served when the baseline SHA changes.
 * Exported for testing purposes.
 */
export function clearPromptCache() {
  cachedRegistry = null;
  cachedBaselineRoot = null;
  cachedCanonPrompts = null;
  cachedPromptsSha = null;
}
