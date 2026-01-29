# ODD Ledger: Learnings & Decisions

The ODD Ledger is a low-ceremony system for capturing **learnings** and **decisions** as first-class documentation.

---

## Quick Setup

```bash
# In your project root
mkdir -p odd/ledger
touch odd/ledger/learnings.jsonl
touch odd/ledger/decisions.jsonl
```

That's it. The Scribe agent (or you manually) can now append entries.

---

## What Goes Where

| Ledger            | Captures                                             | Example                            |
| ----------------- | ---------------------------------------------------- | ---------------------------------- |
| `learnings.jsonl` | Discoveries, drift corrections, clarified invariants | "We thought X but it's actually Y" |
| `decisions.jsonl` | Intentional choices with rationale and tradeoffs     | "We chose A over B because..."     |

---

## Format: JSONL

Each file is **append-only JSONL** (one JSON object per line):

```jsonl
{"id":"learn-20260129-0001","timestamp":"2026-01-29T10:00:00Z","summary":"..."}
{"id":"learn-20260129-0002","timestamp":"2026-01-29T11:00:00Z","summary":"..."}
```

Why JSONL?

- **Append-only** — safe concurrent writes, no merge conflicts
- **Line-oriented** — easy to grep, tail, stream
- **Automation-ready** — parse with `jq`, Python, Node, etc.

---

## Learning Entry Schema

```json
{
  "id": "learn-YYYYMMDD-####",
  "timestamp": "ISO-8601",
  "summary": "One-sentence learning",
  "trigger": "drift_signal | friction | phase_gate | policy | evidence",
  "impact": "Why this matters operationally",
  "confidence": 0.0,
  "sources": ["klappy://...", "path/to/artifact"],
  "evidence": [{ "type": "test|log|artifact|diff", "ref": "..." }],
  "candidate_targets": ["klappy://canon/..."],
  "proposed_escalation": "none | candidate-canon-amendment | candidate-constraint"
}
```

**Triggers explained:**

- `drift_signal` — Version mismatch, roadmap vs reality, "done" without evidence
- `friction` — Repeated agent failure, repeated user frustration
- `phase_gate` — "We're not ready because..."
- `policy` — New constraint or rule discovered
- `evidence` — Tests pass, artifact proves something

---

## Decision Entry Schema

```json
{
  "id": "dec-YYYYMMDD-####",
  "timestamp": "ISO-8601",
  "title": "Short decision title",
  "status": "proposed | accepted | superseded | deprecated",
  "decision": "What we decided",
  "context": "Why we had to decide now",
  "options_considered": [
    { "option": "A", "pros": ["..."], "cons": ["..."] },
    { "option": "B", "pros": ["..."], "cons": ["..."] }
  ],
  "rationale": ["Key reasons tied to constraints/evidence"],
  "consequences": ["What this enables", "What it restricts"],
  "evidence": [{ "type": "doc|test|artifact|commit", "ref": "..." }],
  "links": ["klappy://canon/..."],
  "supersedes": [],
  "superseded_by": null,
  "candidate_promotion": "none | canon-decision-record"
}
```

**Status lifecycle:**

- `proposed` — Draft, under consideration
- `accepted` — Active, governs behavior
- `superseded` — Replaced by another decision (link in `superseded_by`)
- `deprecated` — No longer applies, not replaced

---

## Writing Entries

### Via Scribe Agent (recommended)

The Scribe automatically detects learning and decision moments. It outputs JSON you can append:

```bash
# Scribe outputs:
{"id":"dec-20260129-0001",...}

# You append:
echo '{"id":"dec-20260129-0001",...}' >> odd/ledger/decisions.jsonl
```

### Manually

```bash
# Quick learning entry
echo '{"id":"learn-20260129-0001","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","summary":"Freshness checks prevent wasted updates","trigger":"policy","impact":"Agents stay aligned with canon","confidence":0.9,"sources":[],"evidence":[],"candidate_targets":[],"proposed_escalation":"none"}' >> odd/ledger/learnings.jsonl
```

### Via Script

```javascript
const fs = require("fs");

const entry = {
  id: `learn-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-0001`,
  timestamp: new Date().toISOString(),
  summary: "Your learning here",
  trigger: "policy",
  impact: "Why it matters",
  confidence: 0.8,
  sources: [],
  evidence: [],
  candidate_targets: [],
  proposed_escalation: "none",
};

fs.appendFileSync("odd/ledger/learnings.jsonl", JSON.stringify(entry) + "\n");
```

---

## Reading Entries

```bash
# Last 5 learnings
tail -5 odd/ledger/learnings.jsonl | jq .

# All decisions with "canon" in title
cat odd/ledger/decisions.jsonl | jq 'select(.title | contains("canon"))'

# Promotion candidates
cat odd/ledger/decisions.jsonl | jq 'select(.candidate_promotion != "none")'
```

---

## Promotion Ladder

Ledger entries are cheap. Promotion is selective.

```
┌─────────────────────────────────────────────────────────────┐
│  1. Ledger Entry                                            │
│     - Automatic, low ceremony                               │
│     - Lives in odd/ledger/*.jsonl                           │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  2. Promotion Candidate                                     │
│     - Scribe suggests target (canon doc, constraint, DR)    │
│     - Human reviews                                         │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  3. Canonical Document                                      │
│     - Human drafts and commits to canon                     │
│     - Decision Record in canon/decisions/                   │
│     - Or amendment to existing canon doc                    │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  4. Enforcement                                             │
│     - Only after repeated evidence + stable wording         │
│     - May become constraint or operating rule               │
└─────────────────────────────────────────────────────────────┘
```

**The Scribe proposes. Humans promote.**

---

## Asking for Promotion Candidates

Ask the Scribe:

> "Show me promotion candidates"

It will return:

- Recent ledger entries
- Top 1-3 entries worth promoting
- Suggested target (Decision Record, constraint, doc amendment)

You then decide whether to draft a canonical document.

---

## Decision Records (Promoted Decisions)

When a decision proves durable and broadly relevant, promote it to a canonical Decision Record:

**Location:** `canon/decisions/DR-YYYYMMDD-####-short-slug.md`

**See:** [klappy://canon/decisions/decision-record-standard](https://klappy.dev/canon/decisions/decision-record-standard)

---

## Best Practices

1. **Capture often** — Ledger entries are cheap
2. **Promote rarely** — Only when durable and broadly relevant
3. **Include evidence** — Links to tests, commits, artifacts
4. **Preserve context** — Why did we need to decide/learn this now?
5. **Track supersession** — When reversing a decision, link explicitly

---

## Next Steps

- **Set up agents:** See [Agents Guide](agents.md) to install Scribe and Epistemic Guide
- **Configure oddkit:** See [MCP.md](../MCP.md) for policy tools
- **Learn ODD:** See [klappy.dev/odd](https://klappy.dev/odd) for methodology
