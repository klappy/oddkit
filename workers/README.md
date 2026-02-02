# oddkit MCP Worker

Remote MCP server for oddkit, deployable to Cloudflare Workers. Enables oddkit in Claude.ai on iOS, iPad, and web.

## Features

- **oddkit_orchestrate** — Routes messages to librarian/validate/preflight/catalog
- **oddkit_librarian** — Policy Q&A with citations
- **oddkit_validate** — Completion claim validation

## Setup

1. **Install dependencies:**
   ```bash
   cd workers
   npm install
   ```

2. **Configure Cloudflare:**
   - Update `wrangler.toml` with your account details
   - Optionally add KV namespace for caching

3. **Deploy:**
   ```bash
   npm run deploy
   ```

## Endpoints

| Path | Method | Description |
|------|--------|-------------|
| `/` | GET | Health check |
| `/health` | GET | Health check |
| `/mcp` | POST | MCP JSON-RPC endpoint |

## Connecting to Claude.ai

1. Go to Claude.ai Settings → Integrations → MCP
2. Add new MCP server:
   - URL: `https://oddkit.klappy.dev/mcp`
   - Name: `oddkit`

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BASELINE_URL` | GitHub raw content URL for baseline | `https://raw.githubusercontent.com/klappy/klappy.dev/main` |
| `ODDKIT_VERSION` | Version string | `0.10.0` |

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
npm run dev
```

Then test with:
```bash
curl -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
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
