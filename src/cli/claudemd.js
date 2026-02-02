/**
 * oddkit claudemd command
 *
 * Generates a CLAUDE.md file with oddkit integration instructions for Claude Code.
 * The CLAUDE.md file provides context to Claude Code about how to work with oddkit.
 *
 * Usage:
 *   oddkit claudemd           - Generate CLAUDE.md in current repo
 *   oddkit claudemd --print   - Print to stdout only (no file write)
 *   oddkit claudemd --force   - Overwrite existing CLAUDE.md
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { resolveRepoRoot } from "./init.js";

/**
 * Generate CLAUDE.md content for oddkit integration
 */
export function generateClaudeMdContent(options = {}) {
  const { repoName = "this project", includeAdvanced = false } = options;

  const content = `# CLAUDE.md

This file provides guidance for Claude Code when working with ${repoName}.

## oddkit Integration

This project uses **oddkit** for epistemic governance — policy retrieval, completion validation, and decision capture.

### When to Call oddkit

**Before implementing changes:**
\`\`\`
oddkit_orchestrate({ message: "preflight: <what you're about to implement>", repo_root: "." })
\`\`\`

**When you have policy questions:**
\`\`\`
oddkit_orchestrate({ message: "<your question about rules/constraints>", repo_root: "." })
\`\`\`

**Before claiming completion:**
\`\`\`
oddkit_orchestrate({ message: "done: <what you completed> [artifacts: ...]", repo_root: "." })
\`\`\`

### How to Use Results

1. **Preflight** returns: Start here / Constraints / DoD / Pitfalls
   - Read the suggested files before implementing
   - Note the constraints and definition of done

2. **Librarian** returns: Answer with citations and quotes
   - Use the \`assistant_text\` field directly
   - Follow the evidence-based guidance

3. **Validate** returns: VERIFIED or NEEDS_ARTIFACTS
   - If NEEDS_ARTIFACTS, provide the missing evidence before claiming done
   - Evidence might include: screenshots, test output, build logs

### Quick Examples

**Ask about rules:**
\`\`\`json
{ "message": "What is the definition of done?", "repo_root": "." }
\`\`\`

**Check before implementing:**
\`\`\`json
{ "message": "preflight: add user authentication", "repo_root": "." }
\`\`\`

**Validate completion:**
\`\`\`json
{ "message": "done: implemented login page. Screenshot: login.png", "repo_root": "." }
\`\`\`

### Important Principles

1. **Never pre-inject large documents** — retrieve on-demand via oddkit
2. **Always validate completion claims** — don't just assert done
3. **Use preflight before major changes** — understand constraints first
4. **Quote evidence** — when citing policy, include the source

${includeAdvanced ? getAdvancedSection() : ""}
## Project Context

<!-- Add project-specific context below -->

`;

  return content;
}

/**
 * Advanced section for power users
 */
function getAdvancedSection() {
  return `
### Advanced: Epistemic Modes

oddkit supports three epistemic modes:

| Mode | Description | Posture |
|------|-------------|---------|
| **Discovery** | High fuzziness tolerance, exploring options | Constructive pushback |
| **Planning** | Options crystallizing, decisions locking | Constraints surfacing |
| **Execution** | Concrete, locked, artifact delivery | Evidence required |

Pass epistemic context when known:
\`\`\`json
{
  "message": "...",
  "repo_root": ".",
  "epistemic": {
    "mode_ref": "klappy://canon/epistemic-modes#exploration",
    "confidence": "low"
  }
}
\`\`\`

### Advanced: Ledger Capture

oddkit can capture learnings and decisions to JSONL ledgers:
- \`odd/ledger/learnings.jsonl\` — Things discovered during work
- \`odd/ledger/decisions.jsonl\` — Choices made with rationale

The Scribe component detects "smells" in conversation that might warrant capture.

`;
}

/**
 * Check if CLAUDE.md already exists and has oddkit content
 */
export function checkExistingClaudeMd(repoRoot) {
  const claudeMdPath = join(repoRoot, "CLAUDE.md");

  if (!existsSync(claudeMdPath)) {
    return { exists: false, hasOddkit: false, path: claudeMdPath };
  }

  const content = readFileSync(claudeMdPath, "utf-8");
  const hasOddkit = content.includes("oddkit") || content.includes("oddkit_orchestrate");

  return { exists: true, hasOddkit, path: claudeMdPath, content };
}

/**
 * Run the claudemd command
 */
export async function runClaudeMd(options = {}) {
  const { print, force, repo, advanced } = options;
  const repoRoot = repo || resolveRepoRoot();
  const claudeMdPath = join(repoRoot, "CLAUDE.md");

  // Check if CLAUDE.md exists
  const existing = checkExistingClaudeMd(repoRoot);

  // Generate content
  const content = generateClaudeMdContent({
    repoName: repoRoot.split("/").pop() || "this project",
    includeAdvanced: advanced,
  });

  // Print mode - just output
  if (print) {
    return {
      success: true,
      action: "print",
      content,
      path: claudeMdPath,
    };
  }

  // If exists and has oddkit, require force
  if (existing.exists && existing.hasOddkit && !force) {
    return {
      success: false,
      action: "exists",
      message: `CLAUDE.md already exists with oddkit content. Use --force to overwrite.`,
      path: claudeMdPath,
    };
  }

  // If exists without oddkit, append oddkit section
  if (existing.exists && !existing.hasOddkit && !force) {
    const appendedContent = existing.content.trim() + "\n\n---\n\n" + content;
    writeFileSync(claudeMdPath, appendedContent, "utf-8");
    return {
      success: true,
      action: "appended",
      message: `Appended oddkit section to existing CLAUDE.md`,
      path: claudeMdPath,
    };
  }

  // Write new file
  writeFileSync(claudeMdPath, content, "utf-8");
  return {
    success: true,
    action: "wrote",
    message: `Created CLAUDE.md with oddkit integration`,
    path: claudeMdPath,
  };
}
