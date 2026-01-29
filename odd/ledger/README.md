# ODD Ledger

Append-only JSONL ledgers for learnings and decisions.

## Files

- `learnings.jsonl` — Discoveries, drift corrections, clarified invariants
- `decisions.jsonl` — Intentional choices with rationale and tradeoffs

## Format

One JSON object per line (JSONL). Append-only, merge-friendly, automation-ready.

## Schemas

See `klappy://canon/agents/odd-scribe` for full schema definitions.

### Learning entry (minimal)

```json
{
  "id": "learn-20260129-0001",
  "timestamp": "2026-01-29T10:00:00Z",
  "summary": "One-sentence learning",
  "trigger": "drift_signal",
  "impact": "Why this matters",
  "confidence": 0.7,
  "sources": [],
  "evidence": [],
  "candidate_targets": [],
  "proposed_escalation": "none"
}
```

### Decision entry (minimal)

```json
{
  "id": "dec-20260129-0001",
  "timestamp": "2026-01-29T10:00:00Z",
  "title": "Short title",
  "status": "proposed",
  "decision": "What we chose",
  "context": "Why now",
  "options_considered": [],
  "rationale": [],
  "consequences": [],
  "evidence": [],
  "links": [],
  "supersedes": [],
  "superseded_by": null,
  "candidate_promotion": "none"
}
```

## Promotion

Ledger entries are cheap. Promotion is selective.

1. **Ledger entry** — automatic, low ceremony
2. **Candidate** — Scribe suggests promotion target
3. **Canonical doc PR** — human-approved
4. **Enforcement** — after repeated evidence and stable wording

The Scribe proposes; humans promote.
