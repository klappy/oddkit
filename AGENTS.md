# oddkit Project Memory

## Critical Rules (from painful experience)

1. **NEVER hand-roll parsers in template literals** — Use CDN libs (marked, DOMPurify). Regex in template literals silently corrupts: `\n` becomes literal newline, `\*` drops backslash. See `odd/ledger/learnings.jsonl` learn-20260205-0001.

2. **NEVER assume user's environment is local** — User may be in cloud (Claude Code on web). Cannot set local env vars, cannot commit secrets. See learn-20260205-0003.

3. **Verify model IDs AND API params against LIVE docs** — Don't trust training data. `gpt-5.2-mini` doesn't exist; correct ID is `gpt-5-mini`. GPT-5 family requires `max_completion_tokens` not `max_tokens`. Always RTFM at platform.openai.com/docs. See learn-20260206-0001, learn-20260206-0004.

4. **Cloudflare secrets via dashboard + keep_vars = true** — wrangler deploy with [vars] nukes ALL dashboard env vars not in [vars]. MUST have `keep_vars = true` in wrangler.toml. Then set secrets via dashboard (Workers > Settings > Variables and Secrets > Encrypt). See learn-20260206-0003.

5. **Show real server errors to client** — Never hardcode error messages based on HTTP status. Parse `res.json().error` or `.detail`. See learn-20260205-0005.

6. **Security-first for chat APIs** — Filter to user/assistant roles only, validate body schema, restrict link URLs to http/https, sanitize with DOMPurify. See learn-20260205-0006.

7. **Never rewrite git history** — User explicitly requires new commits, not amends. See dec-20260129-0004.

8. **No markdown formatting in copyable text** — Never use `**`, `*`, or other markdown in URLs, PR bodies, or anything the user will paste. It breaks links and copy-paste. Plain text only. See learn-20260206-0002.

## oddkit Ledger System

- Record learnings: `odd/ledger/learnings.jsonl` (append-only JSONL)
- Record decisions: `odd/ledger/decisions.jsonl` (append-only JSONL)
- Use oddkit CLI for validation: `npx oddkit validate --message "..." --format json`
- Use oddkit CLI for policy lookup: `npx oddkit librarian --query "..." --format json`

## Project Structure

- `workers/` — Cloudflare Worker (MCP + chat UI)
- `workers/src/chat-ui.ts` — Luxury chat HTML (marked@15 + DOMPurify@3 from CDN)
- `workers/src/chat-api.ts` — OpenAI streaming proxy with oddkit context (model: gpt-5-mini)
- `workers/src/index.ts` — Routes: GET / (chat), POST /api/chat, GET /health, POST /mcp
- `odd/ledger/` — Learnings and decisions JSONL files
- `tests/cloudflare-production.test.sh` — Production deployment tests
