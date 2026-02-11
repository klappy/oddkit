# oddkit MCP Worker

Remote MCP server for oddkit, deployable to Cloudflare Workers. Enables oddkit in Claude.ai on iOS, iPad, and web.

## Features

- **Streamable HTTP transport** — MCP 2025-03-26 spec compliant
  - Session management via `Mcp-Session-Id` header
  - GET/SSE support for server-initiated messages
  - POST for JSON-RPC requests
- **oddkit_orchestrate** — Routes messages to librarian/validate/preflight/catalog
- **oddkit_librarian** — Policy Q&A with citations
- **oddkit_validate** — Completion claim validation

## Deployment

Deploys are handled by Cloudflare's GitHub integration (no GitHub Actions, no manual `wrangler deploy`).

| Branch | Environment       | URL                         |
| ------ | ----------------- | --------------------------- |
| `prod` | Production        | `https://oddkit.klappy.dev` |
| `main` | Staging (preview) | Auto-generated preview URL  |

### Workflow

1. Merge PRs to `main` — Cloudflare creates a preview deploy automatically
2. Verify the preview deploy works (check the preview URL `/health`)
3. Promote to production:
   ```bash
   ./scripts/promote.sh          # fast-forward main → prod
   ./scripts/promote.sh --dry-run  # see what would happen
   ```

The promote script gates on version: it checks staging `/health` matches `package.json` before allowing promotion. Set `ODDKIT_STAGING_URL` to the preview URL for full verification.

### Branch protection

- `prod` — no force push, no deletion (enforced by GitHub)
- Promotion is always a fast-forward push from `main`

### Version injection

`ODDKIT_VERSION` is injected at deploy time via the build command:

```
wrangler deploy --var ODDKIT_VERSION:$(node -p "require('../package.json').version")
```

### Local development

```bash
cd workers
npm install
npm run dev
```

## Endpoints

| Path      | Method | Description                               |
| --------- | ------ | ----------------------------------------- |
| `/`       | GET    | Chat UI                                   |
| `/health` | GET    | Health check (JSON with version)          |
| `/mcp`    | POST   | MCP JSON-RPC requests                     |
| `/mcp`    | GET    | SSE streaming (server-initiated messages) |
| `/mcp`    | DELETE | Session termination                       |

## Connecting to Claude.ai

1. Go to Claude.ai Settings → Integrations → MCP
2. Add new MCP server:
   - URL: `https://oddkit.klappy.dev/mcp`
   - Name: `oddkit`

## Environment Variables

| Variable         | Description                              | Default                                                    |
| ---------------- | ---------------------------------------- | ---------------------------------------------------------- |
| `BASELINE_URL`   | GitHub raw content URL for baseline      | `https://raw.githubusercontent.com/klappy/klappy.dev/main` |
| `ODDKIT_VERSION` | Version string (injected at deploy time) | From `package.json`                                        |

## Optional: KV Caching

To enable baseline index caching:

1. Create a KV namespace:

   ```bash
   npx wrangler kv:namespace create BASELINE_CACHE
   ```

2. Update `wrangler.toml`:
   ```toml
   [[kv_namespaces]]
   binding = "BASELINE_CACHE"
   id = "your-namespace-id"
   ```

## Local Development

```bash
cd workers
npm install
npm run dev
```

Then test with:

```bash
# Test tool list
curl -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Test initialize (returns Mcp-Session-Id header)
curl -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{}}}' -i
```

## Architecture

```
Claude.ai (iOS/iPad/Web)
    ↓ HTTPS
Cloudflare Worker (/mcp)
    ↓ JSON-RPC
runOrchestrate()
    ↓ fetch()
GitHub Raw Content API
    ↓
klappy.dev baseline docs
```

The worker fetches the baseline index and documents directly from GitHub, eliminating the need for git clone in the serverless environment.
