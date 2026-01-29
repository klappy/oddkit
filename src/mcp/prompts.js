/**
 * ODD Compass Prompts
 *
 * MCP prompts that teach agents WHEN to call oddkit, WHAT to ask for,
 * and HOW to apply results — WITHOUT preinjecting or duplicating any canon/docs content.
 *
 * These are navigation + triggers + tool contracts only. No doctrine text.
 */

const COMPASS_CODING = `You are working in a repo and you have access to ONE tool: \`oddkit_orchestrate\`.

Do NOT guess policy, process, or definitions when uncertainty matters. Instead, consult oddkit on-demand.

Use these triggers:

1) Policy/Process uncertainty trigger:
- If you are about to state "the rule is…", "we should…", "definition of done is…", "required evidence is…", or you are unsure where guidance lives:
→ Call \`oddkit_orchestrate\` with your question.

Suggested queries:
- "What is the definition of done?"
- "What evidence is required for X?"
- "What are the constraints governing X?"
- "Is this a workaround or promoted policy?"

2) Completion claim trigger:
- If you are about to claim completion ("done", "implemented", "fixed", "shipped", "merged"):
→ Call \`oddkit_orchestrate\` with a completion message that includes artifacts:
  - artifact path(s)
  - commit/PR link
  - command output (or test output)
If missing artifacts, ask for them instead of claiming done.

3) Confusion/contradiction trigger:
- If you see conflicting guidance, low confidence, or "this feels brittle":
→ Call \`oddkit_orchestrate\` asking what governs and what to do next.

How to call:
- Send your natural language message + \`repo_root\` (the workspace root).
- If tool returns advisory/low confidence, do not launder certainty. Ask for the cheapest next artifact.

Output rule:
- If \`assistant_text\` is present, print it verbatim as your answer.
- Otherwise summarize the \`result\` clearly with citations.`;

const COMPASS_PRD = `You are drafting a PRD/discovery doc. You have one tool: \`oddkit_orchestrate\`.

Do NOT invent process requirements. Retrieve them.

Triggers:

1) Before defining success metrics:
→ Ask oddkit: "What is the definition of done for this repo / PRDs?"

2) When you propose constraints/requirements:
→ Ask oddkit: "What constraints or governing docs apply to: <topic>?"

3) When you define evidence/verification:
→ Ask oddkit: "What evidence is required to verify <claim>?"

4) When you finish a PRD draft:
→ Run a completion-style validation message including:
- PRD file path
- key success metrics summary
- how it would be verified

Output rule:
- If \`assistant_text\` exists, print it verbatim.
- If advisory, explicitly state it and propose the cheapest next step.`;

/**
 * All available prompts
 */
const PROMPTS = [
  {
    name: "oddkit_compass",
    description:
      "Operational triggers for when an agent should call oddkit_orchestrate during normal coding.",
    content: COMPASS_CODING,
  },
  {
    name: "oddkit_compass_prd",
    description: "Operational triggers for discovery and PRD creation.",
    content: COMPASS_PRD,
  },
];

/**
 * List all available prompts
 * @returns {Array<{name: string, description: string}>}
 */
export function listPrompts() {
  return PROMPTS.map(({ name, description }) => ({ name, description }));
}

/**
 * Get a specific prompt by name
 * @param {string} name - Prompt name
 * @returns {{name: string, description: string, messages: Array<{role: string, content: {type: string, text: string}}>} | null}
 */
export function getPrompt(name) {
  const prompt = PROMPTS.find((p) => p.name === name);
  if (!prompt) return null;

  return {
    description: prompt.description,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: prompt.content,
        },
      },
    ],
  };
}
