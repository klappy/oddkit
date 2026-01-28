---
uri: oddkit://explain
title: "oddkit explain"
audience: human
exposure: nav
tier: 1
voice: neutral
stability: stable
tags: ["oddkit", "explain", "debugging", "epistemic-hygiene", "agents"]
---

# oddkit explain

`oddkit explain --last` is the canonical way to understand **why oddkit did what it did**.

It turns the last oddkit result into a human-readable explanation **without re-reading the filesystem** and **without re-running retrieval**. This prevents explanation from becoming a second (and potentially divergent) decision engine.

> Invariant: **Explain only renders from the last captured JSON. It never performs retrieval.**

---

## When to use this

Use `oddkit explain --last` when:

- a Librarian answer surprises you
- a Validation verdict blocks progress
- you restarted an agent and need to re-anchor quickly
- you want a human-readable explanation with receipts
- you need to hand off the current state to another agent or person

This is the preferred workflow for "what just happened?" and "what do I do next?"

---

## Commands

```bash
oddkit explain --last
oddkit explain --last --format json
```

**Output formats**

- **Default (markdown)**: human-readable explanation intended for terminals, notes, or copy/paste into issues.
- **JSON (`--format json`)**: enriched machine-readable object intended for agent workflows and orchestration.

---

## What it shows

`oddkit explain --last` renders the last result into these sections:

| Section | Purpose |
| ------- | ------- |
| **Result** | Tool + status/verdict + (optional) short answer |
| **Why this happened** | Rule codes that fired, mapped to human meaning |
| **What to do next** | Actionable suggestions based on the outcome |
| **Evidence used** | Quotes with citations and origin (local vs baseline) |
| **Read next** | Navigation pointers to deepen understanding |
| **Debug** | Repo root, baseline ref, timestamp, policy intent |

---

## Why it is safe

Most systems "explain" by recomputing or guessing.

oddkit does not.

Explain is safe because:

- It reads only `~/.oddkit/last.json`
- It renders using a fixed mapping of `rules_fired` → meaning
- It does not load documents, compute new slices, or run retrieval
- It cannot hallucinate new evidence, because it never searches for evidence

If the last result was wrong or incomplete, Explain can only clarify what happened — it cannot invent a better answer.

---

## How it works (data contract)

Every oddkit command that produces a result (`librarian`, `validate`, `index`) may persist the last result as:

```
~/.oddkit/last.json
```

Explain uses that file as its single input.

The last result is expected to include:

- a top-level `status` or `verdict`
- an `evidence` array (when relevant)
- `read_next` pointers (optional)
- a `debug` object containing:
  - `tool`
  - `timestamp`
  - `repo_root`
  - `baseline_ref` (or null)
  - `rules_fired` (array of rule codes)
  - `policy_intent` (optional, librarian)

Rule meanings come from a fixed mapping (e.g. `rules.js`). Unrecognized rule codes are surfaced explicitly as unmapped.

---

## Typical outcomes

**If Librarian returns SUPPORTED**

- Explain will show which rules enabled the answer
- Evidence will include quoted excerpts and citations
- "What to do next" suggests verifying the cited headings or reading deeper docs

**If Librarian returns INSUFFICIENT_EVIDENCE**

- Explain will show which evidence requirements were not met
- "What to do next" suggests improving the query, adding local docs, or following Read next

**If Validation returns NEEDS_ARTIFACTS**

- Explain will list missing artifact types implied by the verdict
- "What to do next" becomes a concrete checklist (screenshots, logs, links, paths)

---

## Operational guidance (for agents)

Agents should use JSON mode:

```bash
oddkit explain --last --format json
```

Then:

- treat `rules_fired` as the authoritative reason codes
- treat `evidence` as the authoritative citations
- never rewrite or "improve" the explanation into new claims
- use "What to do next" as the step list for remediation

---

## Troubleshooting

**"No last result found"**

If `~/.oddkit/last.json` does not exist, run an oddkit command first:

```bash
oddkit librarian --query "What is the definition of done?"
```

Then run:

```bash
oddkit explain --last
```

---

## Relationship to epistemic hygiene

`oddkit explain` is a core epistemic hygiene mechanism: it makes the system's decisions legible without weakening enforcement or introducing narrative drift.

If the system can't explain its last decision from the same evidence it used to make it, it should not explain at all.
