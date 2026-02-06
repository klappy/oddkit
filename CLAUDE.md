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


## STOP. READ THE LEARNINGS FIRST.

This is the oddkit repo. You are dogfooding oddkit itself. Before doing ANYTHING:

```bash
# Read past mistakes so you don't repeat them
cat odd/ledger/learnings.jsonl | jq -r '.summary'

# Ask oddkit before implementing
npx oddkit librarian --query "What are the constraints for <your task>?" --format json

# Run preflight before any changes
npx oddkit preflight --message "preflight: <what you're about to do>"
```

Past agents have repeatedly broken things by not checking learnings first. The ledger at `odd/ledger/learnings.jsonl` contains hard-won lessons about:
- OpenAI API gotchas (model names, parameter names)
- Cloudflare Worker deployment traps (secrets, wrangler.toml)
- Template literal escaping bugs
- Security requirements for the chat API

READ THEM. USE ODDKIT. DON'T GUESS.

## Project Structure

- `workers/` — Cloudflare Worker (MCP + chat UI)
- `workers/src/chat-ui.ts` — Chat HTML (marked@15 + DOMPurify@3 from CDN)
- `workers/src/chat-api.ts` — OpenAI streaming proxy with oddkit context
- `workers/src/index.ts` — Routes: GET / (chat), POST /api/chat, GET /health, POST /mcp
- `odd/ledger/` — Learnings and decisions (JSONL, append-only)
- `tests/cloudflare-production.test.sh` — Production deployment tests
