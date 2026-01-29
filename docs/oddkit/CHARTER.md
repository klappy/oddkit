---
title: OddKit Charter
status: authoritative
audience: contributors
---

# OddKit Charter

OddKit is **epistemic terrain rendering**.

It is a **map**. It is not a compass.
It shows the structure of truth, constraints, and artifacts — it does not decide what the user "really meant."

## Core Identity

OddKit's job is to:

- render the available knowledge topology (catalog)
- retrieve relevant artifacts (librarian)
- validate claims against constraints (validate)
- explain results in a bounded way (explain)

OddKit must **not** behave like reactive search that guesses intent.

## What OddKit Derives

OddKit may derive behavior from **explicit context** provided by upstream callers, including:

- `epistemic.mode_ref` (canon-derived URI)
- `epistemic.confidence` (caller-declared)

OddKit may also derive internal routing from **explicit actions** returned by its own orchestrator.

## What OddKit Refuses to Infer

OddKit must not:

- infer epistemic mode from phrases ("I'm exploring…", "ready to implement…")
- infer epistemic state from "first message in session"
- detect orientation intent from message content (no "orient me" phrase matching)
- guess user intent and reroute to ORIENT
- invent alternate mode taxonomies

If mode is not provided, OddKit operates in a neutral default posture.
If action is not provided, OddKit detects from message (but ORIENT is never auto-detected).

## Upstream Responsibilities

Upstream agents (e.g., Epistemic Guide) are the **epistemic authority** ("compass"):

- determine mode from Canon-defined rules
- perform phase gating / action validity checks
- pass epistemic context to OddKit when helpful

Upstream agents must not delegate "where should I look?" to themselves.
That question belongs to OddKit (map rendering).

## ORIENT: Map-First Navigation

ORIENT is a first-class action for surfacing the epistemic terrain.

**ORIENT is action-driven only.** It triggers when:

- the caller passes `action: "orient"` explicitly

OddKit does **not** detect ORIENT from message content. Phrases like "orient me" or "show the map" are interpreted upstream (e.g., by the Epistemic Guide) and converted to `action: "orient"` before calling OddKit.

When epistemic context indicates exploration + low confidence, OddKit may set `suggest_orient: true` in the response metadata as a **hint** to the caller. This is advisory only — OddKit never reroutes to ORIENT automatically.

## Success Metrics

Primary success signal:

- **reduction in epistemic correction loops**
  - fewer "that's not what I meant"
  - fewer resets of intent
  - fewer reroutes caused by misclassified action

Secondary signals:

- ORIENT/CATALOG usage increases from explicit calls
- debug logs show clearer "why" for routing decisions
