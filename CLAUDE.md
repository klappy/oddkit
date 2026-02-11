# CLAUDE.md

This file provides guidance for Claude Code when working with oddkit.

## oddkit Integration

This project uses **oddkit** for epistemic governance — policy retrieval, completion validation, and decision capture. oddkit tools are available via MCP and are self-describing. Do not hardcode tool names or params in rules or docs — the MCP server advertises the current API.

### Mandatory Checkpoints (every task)

1. **ORIENT** — At task start, orient against the goal to assess epistemic mode.
2. **PREFLIGHT** — Before implementing, preflight to get constraints, definition of done, and pitfalls. Read the suggested files before coding.
3. **VALIDATE** — Before claiming done, validate with artifact references (test output, file paths, commands run). If NEEDS_ARTIFACTS: provide the missing evidence or flag it honestly. Do not assert done without validation.

### Reactive (call when the situation demands)

- Policy or rules questions — search oddkit docs, do not answer from memory.
- Pressure-test a claim or assumption — challenge it via oddkit.
- Check transition readiness — gate check before changing modes.
- Record a decision or insight — encode it as a durable record.

### How to Use Results

1. **Preflight** returns: Start here / Constraints / DoD / Pitfalls — read the suggested files before implementing.
2. **Search** returns: Answer with citations and quotes — use the `assistant_text` field directly.
3. **Validate** returns: VERIFIED or NEEDS_ARTIFACTS — if NEEDS_ARTIFACTS, provide the missing evidence before claiming done. Evidence includes: test output, build logs, file paths, screenshots.

### Invariants

1. **Never pre-inject large documents** — retrieve on-demand via oddkit.
2. **Never answer policy questions from memory** — retrieve with citations.
3. **Always validate completion claims** — do not just assert done.
4. **Quote evidence** — when citing policy, include the source.


## STOP. Mandatory Pre-Work Checklist.

This is the oddkit repo. You are dogfooding oddkit itself. Every session, every task — no exceptions.

### Step 1: Read the learnings ledger

```bash
cat odd/ledger/learnings.jsonl | jq -r '.summary'
```

Scan every summary. If any learning is relevant to your task, read the full entry. Past agents have broken the same things repeatedly because they skipped this.

### Step 2: RTFM for any external API you're about to call

If your change touches OpenAI, Cloudflare, or any third-party API:
- **Search the live docs** for the exact model/service you're using (not your training data)
- **Verify every parameter** you're sending is supported by that specific model
- Past failures: wrong model names, unsupported params (max_tokens, temperature), tools support — all because agents guessed instead of checking

### Step 3: Orient and preflight via oddkit before implementing

Use the oddkit MCP tools to orient on the task and preflight before writing code. The tools are self-describing — check their descriptions for usage.

### Step 4: Validate via oddkit before claiming done

Use the oddkit validate tool with artifact references. If it says NEEDS_ARTIFACTS, you are NOT done. Provide the missing evidence or flag it honestly.

### Step 5: Record what you learned

Append to `odd/ledger/learnings.jsonl` — especially if you hit friction, discovered a constraint, or found something that contradicts your assumptions.

### Why this matters

The ledger contains hard-won lessons about:
- OpenAI API gotchas (model names, parameter names, tools support per model)
- Cloudflare Worker deployment traps (secrets, wrangler.toml, keep_vars)
- Template literal escaping bugs
- Security requirements for the chat API
- Architecture decisions (never blind RAG, LLM-driven retrieval)

DON'T GUESS. READ. VERIFY. VALIDATE.

## Project Structure

- `workers/` — Cloudflare Worker (MCP + chat UI)
- `workers/src/chat-ui.ts` — Chat HTML (marked@15 + DOMPurify@3 from CDN)
- `workers/src/chat-api.ts` — OpenAI streaming proxy with LLM-driven oddkit tool calling
- `workers/src/index.ts` — Routes: GET / (chat), POST /api/chat, GET /health, POST /mcp
- `odd/ledger/` — Learnings and decisions (JSONL, append-only)
- `tests/cloudflare-production.test.sh` — Deployment tests (URL-parameterized, works against any deploy target)
- `scripts/promote.sh` — Fast-forward main to prod with mandatory staging test gate

## Deployment

- `main` branch → staging (CF preview deploy, auto-generated URL)
- `prod` branch → production (`oddkit.klappy.dev`)
- Promote: `ODDKIT_STAGING_URL=<preview-url> ./scripts/promote.sh`
- Test any deploy: `bash tests/cloudflare-production.test.sh <url>`
