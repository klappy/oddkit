# CLAUDE.md

This file provides guidance for Claude Code when working with oddkit.

## oddkit Integration

This project uses **oddkit** for epistemic governance — policy retrieval, completion validation, and decision capture.

### When to Call oddkit

**Before implementing changes:**
```
oddkit_orchestrate({ message: "preflight: <what you're about to implement>", repo_root: "." })
```

**When you have policy questions:**
```
oddkit_orchestrate({ message: "<your question about rules/constraints>", repo_root: "." })
```

**Before claiming completion:**
```
oddkit_orchestrate({ message: "done: <what you completed> [artifacts: ...]", repo_root: "." })
```

### How to Use Results

1. **Preflight** returns: Start here / Constraints / DoD / Pitfalls
   - Read the suggested files before implementing
   - Note the constraints and definition of done

2. **Librarian** returns: Answer with citations and quotes
   - Use the `assistant_text` field directly
   - Follow the evidence-based guidance

3. **Validate** returns: VERIFIED or NEEDS_ARTIFACTS
   - If NEEDS_ARTIFACTS, provide the missing evidence before claiming done
   - Evidence might include: screenshots, test output, build logs

### Quick Examples

**Ask about rules:**
```json
{ "message": "What is the definition of done?", "repo_root": "." }
```

**Check before implementing:**
```json
{ "message": "preflight: add user authentication", "repo_root": "." }
```

**Validate completion:**
```json
{ "message": "done: implemented login page. Screenshot: login.png", "repo_root": "." }
```

### Important Principles

1. **Never pre-inject large documents** — retrieve on-demand via oddkit
2. **Always validate completion claims** — don't just assert done
3. **Use preflight before major changes** — understand constraints first
4. **Quote evidence** — when citing policy, include the source


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

### Step 3: Preflight via oddkit before implementing

```bash
npx oddkit preflight --message "preflight: <what you're about to do>"
```

### Step 4: Validate via oddkit before claiming done

```bash
npx oddkit validate --message "done: <what you completed>. Artifacts: <evidence>"
```

If oddkit says NEEDS_ARTIFACTS, you are NOT done. Provide the missing evidence or flag it honestly.

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
- `tests/cloudflare-production.test.sh` — Production deployment tests
