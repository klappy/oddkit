# ODD System Overview

> **Canonical methodology:** [klappy.dev/odd](https://klappy.dev/odd)  
> **Tool docs:** You're in them.

This is your starting point for understanding how ODD's pieces fit together.

---

## The Three Layers

```
┌─────────────────────────────────────────────────────────────┐
│                     ODD AGENTS                              │
│  Epistemic Guide (gates) + Scribe (records)                 │
│  Lives in: ~/.cursor/agents/                                │
└─────────────────────────────────────────────────────────────┘
                          │
                          │ call
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                     ODDKIT MCP                              │
│  oddkit_orchestrate, policy_version, policy_get             │
│  Lives in: MCP server (npx oddkit-mcp)                      │
└─────────────────────────────────────────────────────────────┘
                          │
                          │ query
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                     CANON (klappy.dev)                      │
│  Methodology, constraints, definitions, agent roles         │
│  Lives in: github.com/klappy/klappy.dev                     │
└─────────────────────────────────────────────────────────────┘
```

---

## What Each Piece Does

### 1. ODD Agents (IDE Subagents)

**Location:** `~/.cursor/agents/`

| Agent               | Purpose                                           |
| ------------------- | ------------------------------------------------- |
| **Epistemic Guide** | Gates premature action, enforces phase discipline |
| **Scribe**          | Records learnings and decisions to ledgers        |

**Setup:** [Agents Guide](agents.md)

---

### 2. oddkit MCP (Tool Layer)

**Location:** MCP server via `npx oddkit-mcp`

| Tool                    | Purpose                                                  |
| ----------------------- | -------------------------------------------------------- |
| `oddkit_orchestrate`    | Smart router for policy questions, validation, preflight |
| `oddkit_policy_version` | Check canon freshness                                    |
| `oddkit_policy_get`     | Fetch canonical docs by URI                              |

**Setup:** [MCP.md](../MCP.md)

---

### 3. Canon (Methodology)

**Location:** [klappy.dev](https://klappy.dev) / `github.com/klappy/klappy.dev`

Contains:

- ODD methodology and principles
- Agent role definitions
- Decision records
- Constraints and operating rules

**Note:** oddkit uses klappy.dev as the default baseline. Your repo can override specific docs via `supersedes` frontmatter.

---

### 4. Ledger (Per-Project Memory)

**Location:** `odd/ledger/` in your project

| File              | Captures                       |
| ----------------- | ------------------------------ |
| `learnings.jsonl` | Discoveries, drift corrections |
| `decisions.jsonl` | Choices with rationale         |

**Setup:** [Ledger Guide](ledger.md)

---

## Typical Workflow

```
1. User asks to implement something
         │
         ▼
2. Epistemic Guide checks phase
   - If premature → gates and explains
   - If valid → proceeds
         │
         ▼
3. Agent calls oddkit_orchestrate("preflight: implement X")
   - Gets relevant docs, constraints, pitfalls
         │
         ▼
4. Agent implements
         │
         ▼
5. Scribe detects decision/learning moments
   - Records to odd/ledger/*.jsonl
         │
         ▼
6. Agent claims "done"
         │
         ▼
7. oddkit_orchestrate validates
   - Checks evidence against DoD
   - Returns VALIDATED or NEEDS_ARTIFACTS
         │
         ▼
8. Human reviews Scribe's promotion candidates
   - Promotes durable entries to canon
```

---

## Setup Checklist

- [ ] **Install oddkit MCP** — `npx oddkit init` ([MCP.md](../MCP.md))
- [ ] **Copy agents to Cursor** — `~/.cursor/agents/` ([Agents Guide](agents.md))
- [ ] **Create ledger directory** — `mkdir -p odd/ledger` ([Ledger Guide](ledger.md))
- [ ] **Read ODD methodology** — [klappy.dev/odd](https://klappy.dev/odd)

---

## Quick Reference

| I want to...                           | Use                                                         |
| -------------------------------------- | ----------------------------------------------------------- |
| Ask a policy question                  | `oddkit_orchestrate({ message: "What is...?" })`            |
| Validate completion                    | `oddkit_orchestrate({ message: "Done with X" })`            |
| Check what to read before implementing | `oddkit_orchestrate({ message: "preflight: implement X" })` |
| Record a learning                      | Scribe agent or append to `odd/ledger/learnings.jsonl`      |
| Record a decision                      | Scribe agent or append to `odd/ledger/decisions.jsonl`      |
| See promotion candidates               | Ask Scribe: "Show me promotion candidates"                  |
| Gate premature action                  | Epistemic Guide activates automatically                     |

---

## Next Steps

1. **[Agents Guide](agents.md)** — Install Epistemic Guide + Scribe
2. **[Ledger Guide](ledger.md)** — Set up learnings/decisions capture
3. **[MCP.md](../MCP.md)** — Full oddkit tool reference
4. **[QUICKSTART.md](../QUICKSTART.md)** — CLI usage
