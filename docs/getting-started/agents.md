# ODD Agents: Setup & Usage

ODD provides two complementary agent roles that run inside your IDE (Cursor, Claude Code, etc.):

| Agent               | Purpose            | What It Does                                                                   |
| ------------------- | ------------------ | ------------------------------------------------------------------------------ |
| **Epistemic Guide** | Cognitive governor | Gates premature action, surfaces uncertainty, explains what evidence is needed |
| **Scribe**          | Recorder           | Captures learnings and decisions to ledgers, proposes promotion to canon       |

These agents are **not** oddkit CLI tools. They're prompt-based subagents that run inside your IDE and complement oddkit's MCP tooling.

---

## Quick Setup (Cursor)

### 1. Copy agent prompts to Cursor

```bash
# Create the agents directory if it doesn't exist
mkdir -p ~/.cursor/agents

# Copy from klappy.dev canon (if you have it locally)
cp /path/to/klappy.dev/canon/agents/odd-epistemic-guide.md ~/.cursor/agents/
cp /path/to/klappy.dev/canon/agents/odd-scribe.md ~/.cursor/agents/

# Or download from GitHub
curl -o ~/.cursor/agents/odd-epistemic-guide.md \
  https://raw.githubusercontent.com/klappy/klappy.dev/main/canon/agents/odd-epistemic-guide.md

curl -o ~/.cursor/agents/odd-scribe.md \
  https://raw.githubusercontent.com/klappy/klappy.dev/main/canon/agents/odd-scribe.md
```

### 2. (Optional) Add trigger rules

```bash
mkdir -p ~/.cursor/rules

# Download capture rule for Scribe
curl -o ~/.cursor/rules/odd-scribe-capture.md \
  https://raw.githubusercontent.com/klappy/klappy.dev/main/.cursor/rules/odd-scribe-capture.md
```

### 3. Verify

In Cursor, the agents should now appear in your subagent list. You can invoke them explicitly or they'll trigger automatically based on context.

---

## The Epistemic Guide

**Purpose:** Prevent premature action and ensure epistemic honesty.

**When it activates:**

- User jumps to implementation before requirements are clear
- User proposes architecture before constraints are defined
- User claims "done" without evidence
- Phase transitions are implied without explicit promotion

**What it does:**

- Determines current epistemic phase (Idea → Discovery → PRD → Planning → Implementation → Validation → Promotion)
- Gates actions that are invalid for the current phase
- Explains what evidence is missing
- Never "helps a little anyway" — maintains firm boundaries

**Example interaction:**

> **User:** Let's implement the auth system  
> **Guide:** Per `klappy://canon/agents/odd-epistemic-guide`, we appear to still be in **Discovery**. Success criteria and constraints have not been established. Valid actions at this phase: clarifying questions, constraint gathering, requirements drafting.

**Canonical source:** `klappy://canon/agents/odd-epistemic-guide`

---

## The Scribe

**Purpose:** Capture learnings and decisions before they evaporate.

**When it activates:**

- Something epistemically meaningful just happened
- A choice was made between options
- A new constraint or boundary was articulated
- Drift was detected and corrected
- Evidence was produced

**What it does:**

- Writes entries to `odd/ledger/learnings.jsonl` or `odd/ledger/decisions.jsonl`
- Proposes promotion candidates for durable canon
- Does NOT promote unilaterally — humans decide

**Example output:**

```json
{
  "id": "dec-20260129-0001",
  "timestamp": "2026-01-29T14:30:00Z",
  "title": "Canon-target-first freshness protocol",
  "status": "accepted",
  "decision": "Derived prompts must check oddkit_policy_version before proposing updates",
  "rationale": ["Prevents wasted updates to intermediate versions"],
  "candidate_promotion": "canon-decision-record"
}
```

**Canonical source:** `klappy://canon/agents/odd-scribe`

---

## How They Work Together

```
┌─────────────────────┐     ┌─────────────────────┐
│   Epistemic Guide   │     │       Scribe        │
│                     │     │                     │
│  - Gates actions    │     │  - Records events   │
│  - Enforces phases  │     │  - Proposes promotion│
│  - Surfaces gaps    │     │  - Preserves context │
└─────────────────────┘     └─────────────────────┘
         │                           │
         │                           │
         ▼                           ▼
┌─────────────────────────────────────────────────┐
│                  oddkit MCP                      │
│                                                  │
│  - oddkit_orchestrate (policy questions)        │
│  - oddkit_policy_version (freshness checks)     │
│  - oddkit_policy_get (fetch canon docs)         │
└─────────────────────────────────────────────────┘
```

- **Guide** prevents invalid transitions
- **Scribe** prevents valuable insight from being lost
- **oddkit** provides the canonical truth they both reference

---

## Freshness: Canon-Target-First

Both agents include a **freshness check** mechanism:

1. At first activation, agent calls `oddkit_policy_version`
2. Compares local `canon_pinned_commit` to authoritative `canon_target.commit`
3. If stale, offers three options:
   - **A)** Continue with current prompt
   - **B)** Soft refresh (consult latest for this session only)
   - **C)** Produce a patch (requires human approval)

This ensures agents don't drift from canon while preserving human control over updates.

---

## Derived vs Canonical

| Location                   | Type      | What Lives There                               |
| -------------------------- | --------- | ---------------------------------------------- |
| `klappy.dev/canon/agents/` | Canonical | Source of truth for agent roles                |
| `~/.cursor/agents/`        | Derived   | IDE-specific prompts, pinned to a canon commit |

**Rule:** Update canon first, then sync outward to derived prompts. Never edit derived prompts directly.

---

## Troubleshooting

### Agents not appearing in Cursor

1. Verify files exist in `~/.cursor/agents/`
2. Restart Cursor
3. Check file permissions

### Agent seems stale

1. Check the `canon_pinned_commit` in the agent's frontmatter
2. Compare to current canon via `git log` in klappy.dev
3. If behind, fetch latest and update derived prompt

### oddkit tools not available to agents

1. Ensure oddkit MCP is configured (see [MCP.md](../MCP.md))
2. Verify `oddkit_orchestrate` appears in Cursor's tool list
3. Check MCP server logs for errors

---

## Next Steps

- **Set up ledgers:** See [Ledger Guide](ledger.md) for learnings/decisions capture
- **Configure MCP:** See [MCP.md](../MCP.md) for oddkit tool integration
- **Learn ODD:** See [klappy.dev/odd](https://klappy.dev/odd) for methodology docs
