# Oddkit Compatibility Contract

> Machine-readable contract. Changes require version bump.

**Contract Version:** 1.0.0

## Required Phases

1. **Baseline Resolution** — Resolve baseline ref to commit SHA
2. **Cache Management** — Optional purge (`--fresh`), record state in receipt
3. **Test Execution** — Run all required tests serially
4. **Integration Probes** — Run all required probes
5. **Receipt Generation** — Emit JSON + markdown receipts

## Required Tests (Ordered)

Tests MUST run in this order. Stateful tests are last.

| Order | Name              | Script                                            | Category     |
| ----- | ----------------- | ------------------------------------------------- | ------------ |
| 1     | smoke             | `npm test`                                        | core         |
| 2     | mcp               | `npm run test:mcp`                                | core         |
| 3     | tooljson          | `npm run test:tooljson`                           | core         |
| 4     | antifragile       | `npm run test:antifragile`                        | orchestrator |
| 5     | catalog           | `npm run test:catalog`                            | orchestrator |
| 6     | policy            | `npm run test:policy`                             | policy       |
| 7     | adversarial       | `bash tests/adversarial.sh`                       | arbitration  |
| 8     | mcp-instructions  | `bash tests/mcp-instructions-smoke.sh`            | mcp          |
| 9     | mcp-prompts       | `bash tests/mcp-prompts-smoke.sh`                 | mcp          |
| 10    | mcp-orchestrate   | `bash tests/mcp-orchestrate-test.sh`              | mcp          |
| 11    | instruction-sync  | `bash tests/orchestrate-instruction-sync.test.sh` | sync         |
| 12    | sync-agents       | `bash tests/sync-agents.test.sh`                  | sync         |
| 13    | noindex-exclusion | `bash tests/noindex-exclusion.test.sh`            | containment  |
| 14    | odd-uri-scheme    | `bash tests/odd-uri-scheme.test.sh`               | containment  |
| 15    | preflight         | `npm run test:preflight`                          | stateful     |

## Required Probes

| Probe                  | Verification                              |
| ---------------------- | ----------------------------------------- |
| canon_target           | Baseline commit resolves without error    |
| index_merge            | Local + baseline docs merge, counts > 0   |
| klappy_uri_containment | Resolution works AND traversal blocked    |
| odd_uri_containment    | Normalization works AND traversal blocked |
| librarian_epoch4       | Query returns SUPPORTED with evidence     |
| noindex_exclusion      | Excluded count is tracked (>= 0)          |

## Receipt Requirements

JSON receipt MUST include:

```
oddkit.commit      — Full SHA of oddkit repo HEAD
oddkit.dirty       — Boolean: working tree has uncommitted changes
baseline.url       — Baseline repo URL
baseline.ref       — Requested ref (branch/tag)
baseline.commit    — Resolved commit SHA
cache.fresh        — Boolean: cache was purged before pull
cache.path         — Path to baseline cache directory
contract.version   — This contract's version string
contract.sha256    — First 8 chars of this file's SHA256
tests.ordered      — Boolean: tests ran in contract order
tests.results[]    — Per-test name, passed, duration, error
probes.results[]   — Per-probe name, passed, data, error
verdict            — COMPATIBLE | INCOMPATIBLE
```

## Verdict Rules

| Condition                          | Verdict      |
| ---------------------------------- | ------------ |
| All tests pass AND all probes pass | COMPATIBLE   |
| Any test fails OR any probe fails  | INCOMPATIBLE |

No DEGRADED state. Binary verdict only.

## State Isolation

When `ODDKIT_STATE_DIR` is set:

- All state files (last.json) write to that directory
- Prevents cross-test contamination in CI

## Contract Changes

- Adding a test: Minor version bump (1.0.0 → 1.1.0)
- Removing a test: Major version bump (1.0.0 → 2.0.0)
- Changing verdict rules: Major version bump
- Receipt field additions: Minor version bump
- Receipt field removals: Major version bump
