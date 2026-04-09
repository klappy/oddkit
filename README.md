# oddkit

An open-source MCP server that gives your AI structured memory, epistemic discipline, and the ability to build on what came before.

> **Your AI forgets everything between sessions. It guesses instead of checking. It can't tell a brainstorm from a decision. oddkit fixes that.**

oddkit reads markdown files from a GitHub repository — decisions, constraints, learnings, governance — and makes them available to your AI through structured tools. It works with any AI tool that supports MCP: Claude, ChatGPT, Gemini, Cursor, Claude Code, Lovable, Replit, ElevenLabs voice agents, and more.

**Knowledge base repo:** [klappy/klappy.dev](https://github.com/klappy/klappy.dev) — the content oddkit reads from

---

## Get Started in 30 Seconds

oddkit is a remote MCP server. You don't install anything — you point your AI tool at a URL.

### Claude.ai

Settings → Connectors → Add Custom Integration:
- **Name:** `oddkit`
- **URL:** `https://oddkit.klappy.dev/mcp`

### ChatGPT

Settings → Developer Mode → Create App → add MCP server URL:

`https://oddkit.klappy.dev/mcp`

### Claude Code / Cursor / Any MCP Client

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "oddkit": {
      "type": "http",
      "url": "https://oddkit.klappy.dev/mcp"
    }
  }
}
```

Or in Claude Code: `claude mcp add --transport http oddkit https://oddkit.klappy.dev/mcp`

### Lovable / Replit / Gemini / ElevenLabs / Others

Any tool that supports MCP can connect. Look for "MCP server" or "custom integration" in your tool's settings and provide the URL:

`https://oddkit.klappy.dev/mcp`

---

## What oddkit Does

Once connected, your AI gets access to these tools:

| Tool | What It Does |
|------|-------------|
| **orient** | Assess a situation, surface unresolved questions, identify which mode you're in (exploring, planning, executing) |
| **search** | Find relevant documents, constraints, and prior decisions by topic |
| **get** | Fetch a specific document by URI |
| **challenge** | Pressure-test a claim, assumption, or proposal against existing constraints |
| **gate** | Check readiness before transitioning between phases |
| **encode** | Structure a decision, insight, or boundary as a durable record |
| **preflight** | Pre-implementation check — surfaces constraints, definition of done, and pitfalls |
| **validate** | Verify completion claims against required artifacts |
| **catalog** | List available documentation with filtering and sorting |

### Try It Right Now

After connecting, say "use oddkit" or "ask oddkit" to invoke it:

- *"Use oddkit to orient me on whether I should [decision you're facing]"*
- *"Ask oddkit to challenge my assumption that [something you believe]"*
- *"Use oddkit to encode this decision: we chose [X] because [Y]"*
- *"[paste meeting notes] Use oddkit to encode the key decisions from this meeting"*

---

## Bootstrap Your Project

To make oddkit proactive — so the AI uses these tools automatically instead of waiting for you to ask — add a bootstrap prompt to your project instructions. See the [full bootstrap guide](https://klappy.dev/page/docs/oddkit/proactive/proactive-bootstrap) or start with the essentials in [Getting Started with ODD and oddkit](https://klappy.dev/page/writings/getting-started-with-odd-and-oddkit).

---

## Point oddkit at Your Own Knowledge Base

By default, oddkit reads from [klappy.dev](https://github.com/klappy/klappy.dev). You can point it at any GitHub repo using the `canon_url` parameter:

```
canon_url: "https://raw.githubusercontent.com/YOUR_ORG/YOUR_REPO/main"
```

oddkit reads markdown files with YAML frontmatter. Start with a few files — decisions, constraints, learnings — and grow from there. No schema required.

---

## Architecture

oddkit is a Cloudflare Worker that:

1. Fetches markdown files from a GitHub repository (zip download, cached)
2. Indexes them with BM25 full-text search
3. Parses YAML frontmatter for metadata, filtering, and sorting
4. Exposes structured tools via the MCP protocol

It's stateless, serverless, and framework-agnostic. The knowledge base is your repo. oddkit just makes it searchable and structured.

---

## Development

```bash
cd workers
npm install
npm run dev     # Local development
npm run deploy  # Deploy to Cloudflare
```

**Branches:**
- `main` → staging preview
- `prod` → production (`oddkit.klappy.dev`)

Promote staging to production: `./scripts/promote.sh`

---

## Learn More

- **[Getting Started with ODD and oddkit](https://klappy.dev/page/writings/getting-started-with-odd-and-oddkit)** — five-minute quickstart with bootstrap instructions
- **[The Journey from AI Tasks to AI-Augmented Workflows](https://klappy.dev/page/writings/the-journey-from-ai-tasks-to-ai-augmented-workflows)** — the four-step progression
- **[From Passive to Proactive](https://klappy.dev/page/writings/from-passive-to-proactive)** — the story behind oddkit's proactive design
- **[klappy.dev repo](https://github.com/klappy/klappy.dev)** — the knowledge base oddkit reads from

---

## License

MIT
