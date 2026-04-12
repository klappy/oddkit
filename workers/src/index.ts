/**
 * oddkit MCP Worker
 *
 * Remote MCP server for oddkit, deployable to Cloudflare Workers.
 * Uses Cloudflare's `createMcpHandler` from the Agents SDK for
 * streamable-http transport (MCP 2025-03-26 spec).
 *
 * Architecture:
 *   /mcp          → createMcpHandler (MCP protocol)
 *   /             → Redirect to getting started article
 *   /health       → Health check
 *   /.well-known/ → MCP server card
 *   *             → 404
 */

import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { handleUnifiedAction, type Env } from "./orchestrate";
import { ZipBaselineFetcher } from "./zip-baseline-fetcher";
import { RequestTracer } from "./tracing";
import { renderNotFoundPage } from "./not-found-ui";
import pkg from "../package.json";

export type { Env };

const BUILD_VERSION = pkg.version;

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

interface PromptRegistryEntry {
  id: string;
  uri: string;
  path: string;
  audience: string;
}

interface PromptRegistry {
  version: string;
  instructions: PromptRegistryEntry[];
}

// ──────────────────────────────────────────────────────────────────────────────
// Time utility helpers (E0008.2) — pure functions, no env dependency
// ──────────────────────────────────────────────────────────────────────────────

function parseTimestamp(input: string | number): Date {
  if (typeof input === "string" && /^\d+(\.\d+)?$/.test(input)) {
    input = Number(input);
  }
  if (typeof input === "number") {
    const ms = input > 1e12 ? input : input * 1000;
    const d = new Date(ms);
    if (isNaN(d.getTime())) throw new Error(`Invalid numeric timestamp: ${input}`);
    return d;
  }
  const d = new Date(input);
  if (isNaN(d.getTime())) throw new Error(`Invalid timestamp string: "${input}"`);
  return d;
}

function formatDuration(ms: number): string {
  const neg = ms < 0;
  let rem = Math.abs(ms);
  const d = Math.floor(rem / 86400000); rem %= 86400000;
  const h = Math.floor(rem / 3600000); rem %= 3600000;
  const m = Math.floor(rem / 60000); rem %= 60000;
  const s = Math.floor(rem / 1000);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s || parts.length === 0) parts.push(`${s}s`);
  return (neg ? "-" : "") + parts.join(" ");
}

// ──────────────────────────────────────────────────────────────────────────────
// Prompt registry helpers — ZipBaselineFetcher with module-level cache
//
// Uses ZipBaselineFetcher (R2/KV content-addressed cache) for both registry
// and prompt content. Module-level cache (5-min TTL) avoids re-fetching the
// registry on every MCP request. Prompt content is fetched lazily on
// prompts/get and benefits from ZipBaselineFetcher's R2 cache.
//
// DO NOT replace with raw HTTP fetch — that bypasses the R2 cache pipeline
// and hammers raw.githubusercontent.com on every request. The .md filter
// bug that previously caused REGISTRY.json to return null has been fixed
// in ZipBaselineFetcher.getUnzipped (see zip-baseline-fetcher.ts).
// ──────────────────────────────────────────────────────────────────────────────

let cachedRegistry: PromptRegistry | null = null;
let registryFetchedAt = 0;
const REGISTRY_CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchPromptsRegistry(env: Env): Promise<PromptRegistry | null> {
  const now = Date.now();
  if (cachedRegistry && now - registryFetchedAt < REGISTRY_CACHE_TTL_MS) {
    return cachedRegistry;
  }
  try {
    const fetcher = new ZipBaselineFetcher(env);
    const registryJson = await fetcher.getFile("canon/instructions/REGISTRY.json");
    if (!registryJson) return cachedRegistry;
    cachedRegistry = JSON.parse(registryJson) as PromptRegistry;
    registryFetchedAt = now;
    return cachedRegistry;
  } catch {
    return cachedRegistry;
  }
}

async function fetchPromptContent(env: Env, path: string): Promise<string | null> {
  try {
    const fetcher = new ZipBaselineFetcher(env);
    const content = await fetcher.getFile(path);
    if (!content) return null;
    return content.replace(/^---[\s\S]*?---\n/, "").trim();
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// MCP Server — tool, resource, and prompt registration
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Create a fresh McpServer instance per request.
 *
 * MCP SDK 1.26.0+ requires new instances per request to prevent
 * cross-client data leakage (CVE fix). The `env` is closed over
 * at request time so tools can access bindings.
 *
 * Prompts are fetched from the baseline registry via ZipBaselineFetcher
 * (R2-cached) with module-level caching (5-minute TTL). Prompt content
 * is fetched lazily on prompts/get via the same R2 pipeline.
 */
async function createServer(env: Env, tracer?: RequestTracer): Promise<McpServer> {
  const server = new McpServer(
    {
      name: "oddkit",
      version: env.ODDKIT_VERSION || BUILD_VERSION,
    },
    {
      instructions:
        "oddkit provides epistemic governance — policy retrieval, completion validation, and decision capture. Use the unified `oddkit` tool with action parameter for multi-step workflows with state threading, or use individual tools (oddkit_search, oddkit_orient, oddkit_challenge, etc.) for direct, stateless calls.",
    },
  );

  // ── Layer 1: Unified orchestrator (state threading) ──────────────────────

  server.tool(
    "oddkit",
    `Epistemic guide for Outcomes-Driven Development. Routes to orient, challenge, gate, encode, search, get, catalog, validate, preflight, version, or cleanup_storage actions.

Use when:
- Starting work: action="orient" to assess epistemic mode
- Policy/canon questions: action="search" with your query
- Fetching a specific doc: action="get" with URI
- Pressure-testing claims: action="challenge"
- Checking transition readiness: action="gate"
- Recording decisions: action="encode"
- Pre-implementation: action="preflight"
- Validating completion: action="validate"
- Listing available docs: action="catalog"`,
    {
      action: z.enum([
        "orient", "challenge", "gate", "encode", "search", "get",
        "catalog", "validate", "preflight", "version", "cleanup_storage",
      ]).describe("Which epistemic action to perform."),
      input: z.string().describe("Primary input — query, claim, URI, goal, or completion claim depending on action."),
      context: z.string().optional().describe("Optional supporting context."),
      mode: z.enum(["exploration", "planning", "execution"]).optional().describe("Optional epistemic mode hint."),
      canon_url: z.string().optional().describe("Optional GitHub repo URL for canon override."),
      include_metadata: z.boolean().optional().describe("When true, search/get responses include a metadata object with full parsed frontmatter. Default: false."),
      section: z.string().optional().describe("For action='get': extract only the named ## section from the document. Returns section content or available sections if not found."),
      sort_by: z.enum(["date", "path"]).optional().describe("For action='catalog': sort articles. 'date' returns newest first (requires frontmatter). 'path' returns all docs alphabetically, including undated."),
      limit: z.number().min(1).max(500).optional().describe("For action='catalog': max articles to return when sort_by is provided. Default: 10, max: 500."),
      offset: z.number().min(0).optional().describe("For action='catalog': skip this many articles before returning results. Use with limit for pagination. Default: 0."),
      filter_epoch: z.string().optional().describe("For action='catalog': filter to articles with this epoch value in frontmatter (e.g. 'E0007')."),
      state: z.record(z.string(), z.unknown()).optional().describe("Optional client-side conversation state, passed back and forth."),
    },
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async (args) => {
      const result = await handleUnifiedAction({
        action: args.action,
        input: args.input,
        context: args.context,
        mode: args.mode,
        canon_url: args.canon_url,
        include_metadata: args.include_metadata,
        section: args.section,
        sort_by: args.sort_by,
        limit: args.limit,
        offset: args.offset,
        filter_epoch: args.filter_epoch,
        state: args.state as any,
        env,
        tracer,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ── Layer 2: Individual tools (stateless, direct access) ─────────────────

  const individualTools: Array<{
    name: string;
    description: string;
    action: string;
    schema: Record<string, z.ZodTypeAny>;
    annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  }> = [
    {
      name: "oddkit_orient",
      description: "Assess a goal, idea, or situation against epistemic modes (exploration/planning/execution). Surfaces unresolved items, assumptions, and questions. Call proactively whenever context shifts, not just at session start.",
      action: "orient",
      schema: {
        input: z.string().describe("A goal, idea, or situation description to orient against."),
        canon_url: z.string().optional().describe("Optional: GitHub repo URL for canon override."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    {
      name: "oddkit_challenge",
      description: "Pressure-test a claim, assumption, or proposal against canon constraints. Surfaces tensions, missing evidence, and contradictions. Challenge proactively before encoding consequential decisions.",
      action: "challenge",
      schema: {
        input: z.string().describe("A claim, assumption, or proposal to challenge."),
        mode: z.enum(["exploration", "planning", "execution"]).optional().describe("Optional epistemic mode for proportional challenge."),
        canon_url: z.string().optional().describe("Optional: GitHub repo URL for canon override."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    {
      name: "oddkit_gate",
      description: "Check transition prerequisites before changing epistemic modes. Validates readiness and blocks premature convergence. Gate at every implicit mode transition, not just formal ones.",
      action: "gate",
      schema: {
        input: z.string().describe("The proposed transition (e.g., 'ready to build', 'moving to planning')."),
        context: z.string().optional().describe("Optional context about what's been decided so far."),
        canon_url: z.string().optional().describe("Optional: GitHub repo URL for canon override."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    {
      name: "oddkit_encode",
      description: "Structure a decision, insight, or boundary as a durable record. IMPORTANT: This tool returns the structured artifact in the response — it does NOT persist or save it. The caller must save the output to storage. Standard artifact types: Observations (O), Learnings (L), Decisions (D), Constraints (C), Handoffs (H) — OLDC+H. Track OLDC+H continuously — encode what the user shared, encode what you did. Persist at natural breakpoints.",
      action: "encode",
      schema: {
        input: z.string().describe("A decision, insight, or boundary to capture."),
        context: z.string().optional().describe("Optional supporting context."),
        canon_url: z.string().optional().describe("Optional: GitHub repo URL for canon override."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "oddkit_search",
      description: "Search canon and baseline docs by natural language query or tags. Returns ranked results with citations and excerpts. Search before claiming — not just when asked.",
      action: "search",
      schema: {
        input: z.string().describe("Natural language query or tags to search for."),
        canon_url: z.string().optional().describe("Optional: GitHub repo URL for canon override."),
        include_metadata: z.boolean().optional().describe("When true, each hit includes a metadata object with full parsed frontmatter. Default: false."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    {
      name: "oddkit_get",
      description: "Fetch a canonical document by klappy:// URI. Returns full content, commit, and content hash. Use section parameter to extract a specific ## section.",
      action: "get",
      schema: {
        input: z.string().describe("Canonical URI (e.g., klappy://canon/values/orientation)."),
        canon_url: z.string().optional().describe("Optional: GitHub repo URL for canon override."),
        include_metadata: z.boolean().optional().describe("When true, response includes a metadata object with full parsed frontmatter. Default: false."),
        section: z.string().optional().describe("Extract only the named ## section from the document. Returns available sections if not found."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    {
      name: "oddkit_catalog",
      description: "Lists available documentation with categories, counts, and start-here suggestions. Supports temporal discovery: use sort_by='date' to get recent articles with full frontmatter metadata.",
      action: "catalog",
      schema: {
        canon_url: z.string().optional().describe("Optional: GitHub repo URL for canon override."),
        sort_by: z.enum(["date", "path"]).optional().describe("Sort articles. 'date' returns newest first (requires frontmatter). 'path' returns all docs alphabetically, including undated."),
        limit: z.number().min(1).max(500).optional().describe("Max articles to return when sort_by is provided. Default: 10, max: 500."),
        offset: z.number().min(0).optional().describe("Skip this many articles before returning results. Use with limit for pagination. Default: 0."),
        filter_epoch: z.string().optional().describe("Filter to articles with this epoch value in frontmatter (e.g. 'E0007')."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    {
      name: "oddkit_validate",
      description: "Validates completion claims against required artifacts. Returns VERIFIED or NEEDS_ARTIFACTS. Validate proactively before claiming any task complete.",
      action: "validate",
      schema: {
        input: z.string().describe("The completion claim with artifact references."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "oddkit_preflight",
      description: "Pre-implementation check. Returns relevant docs, constraints, definition of done, and pitfalls. Preflight before any execution that produces an artifact.",
      action: "preflight",
      schema: {
        input: z.string().describe("Description of what you're about to implement."),
        canon_url: z.string().optional().describe("Optional: GitHub repo URL for canon override."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    {
      name: "oddkit_version",
      description: "Returns oddkit version and the authoritative canon target (commit/mode).",
      action: "version",
      schema: {
        canon_url: z.string().optional().describe("Optional: GitHub repo URL for canon override."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "oddkit_cleanup_storage",
      description: "Storage hygiene: clears orphaned cached data. NOT required for correctness — content-addressed caching ensures fresh content is served automatically when the baseline changes.",
      action: "cleanup_storage",
      schema: {
        canon_url: z.string().optional().describe("Optional: GitHub repo URL for canon override."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];

  for (const tool of individualTools) {
    server.tool(
      tool.name,
      tool.description,
      tool.schema,
      tool.annotations,
      async (args: Record<string, unknown>) => {
        const result = await handleUnifiedAction({
          action: tool.action,
          input: (args.input as string) || "",
          context: args.context as string | undefined,
          mode: args.mode as string | undefined,
          canon_url: args.canon_url as string | undefined,
          include_metadata: args.include_metadata as boolean | undefined,
          section: args.section as string | undefined,
          sort_by: args.sort_by as string | undefined,
          limit: args.limit as number | undefined,
          offset: args.offset as number | undefined,
          filter_epoch: args.filter_epoch as string | undefined,
          env,
          tracer,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );
  }

  // ── Telemetry tools (E0008) ──────────────────────────────────────────────

  server.tool(
    "telemetry_public",
    `Return public telemetry disclosures and usage leaderboards. Shows consumer, tool, canon URL, and document leaderboards. Same data the maintainer sees — no information asymmetry.

Dataset: oddkit_telemetry (Cloudflare Analytics Engine)
Schema:
  blob1  — event_type      "mcp_request" | "tool_call"
  blob2  — method          JSON-RPC method (e.g. "tools/call")
  blob3  — tool_name       oddkit action (e.g. "orient", "search")
  blob4  — consumer_label  best-effort caller identity
  blob5  — consumer_source how label was resolved (e.g. "user-agent")
  blob6  — canon_url       which repo baseline is being served
  blob7  — document_uri    for get calls, the klappy:// URI requested
  blob8  — worker_version  oddkit version string
  double1 — count          always 1
  double2 — duration_ms    request processing time
  index1 — sampling_key    consumer label

Use SUM(_sample_interval) instead of COUNT(*) to account for Analytics Engine sampling.
Time filter example: WHERE timestamp > NOW() - INTERVAL '30' DAY`,
    {
      sql: z.string().describe("Analytics Engine SQL query against the oddkit_telemetry dataset."),
    },
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async ({ sql }) => {
      if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              action: "telemetry_public",
              result: { error: "Telemetry queries not configured. CF_ACCOUNT_ID and CF_API_TOKEN required." },
            }, null, 2),
          }],
        };
      }

      // Guard 1: Dataset allowlist — handled by validateTelemetryQuery inside queryTelemetry.

      // Guard 2: Rate limiting — deferred to Phase 2 (requires consumer identification for per-consumer limits).
      // Current guard: Analytics Engine 10k queries/day quota.

      // Guard 3: Error sanitization — never leak raw CF API responses
      const { queryTelemetry } = await import("./telemetry");
      let result: unknown;
      try {
        result = await queryTelemetry(env, sql);
        // Check for CF API error responses
        if (typeof result === 'object' && result !== null && 'success' in result) {
          const r = result as Record<string, unknown>;
          if (r.success === false) {
            result = { error: "Query failed. Check SQL syntax against the schema in the tool description." };
          }
        }
      } catch {
        result = { error: "Query execution failed." };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            action: "telemetry_public",
            result: { data: result, generated_at: new Date().toISOString() },
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    "telemetry_policy",
    "Return oddkit telemetry and sharing policy guidance. What is tracked, what is excluded, and why. Fetched from canonical governance document at runtime.",
    {},
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async () => {
      // Fetch the governance doc from canon
      const fetcher = new ZipBaselineFetcher(env);
      let policyContent = "Governance document not found. See https://github.com/klappy/klappy.dev/blob/main/canon/constraints/telemetry-governance.md";

      try {
        const content = await fetcher.getFile("canon/constraints/telemetry-governance.md");
        if (content) policyContent = content;
      } catch {
        // Fall through to default message
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            action: "telemetry_policy",
            result: {
              policy: policyContent,
              governance_uri: "klappy://canon/constraints/telemetry-governance",
              self_report_headers: {
                "x-oddkit-client": "Your client name (highest priority identifier)",
                "x-oddkit-client-version": "Your client version",
                "x-oddkit-agent-name": "The AI agent name",
                "x-oddkit-agent-version": "The AI agent version",
                "x-oddkit-surface": "Where this is running (e.g. claude.ai, vscode)",
                "x-oddkit-contact-url": "URL for your project or org",
                "x-oddkit-policy-url": "Your privacy/telemetry policy URL",
                "x-oddkit-capabilities": "Comma-separated capability list",
              },
              generated_at: new Date().toISOString(),
            },
          }, null, 2),
        }],
      };
    },
  );

  // ── Time utility (E0008.2) ──────────────────────────────────────────────

  server.tool(
    "oddkit_time",
    "Stateless time utility. Returns current UTC time, elapsed time since a reference timestamp, or the delta between two timestamps. No params = current time. One timestamp = elapsed. Two timestamps = delta. Accepts ISO 8601 strings or Unix epoch (seconds or milliseconds).",
    {
      reference: z.union([z.string(), z.number()]).optional().describe("Reference timestamp (ISO 8601 string or Unix epoch in ms or seconds). When provided alone, returns elapsed time from reference to now."),
      compare: z.union([z.string(), z.number()]).optional().describe("Second timestamp for delta calculation. Used with reference to compute the difference between two arbitrary timestamps."),
    },
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ reference, compare }) => {
      const startTime = Date.now();
      const now = new Date();
      const result: Record<string, unknown> = { now: now.toISOString() };
      let assistantText = `Current UTC time: ${now.toISOString()}`;

      try {
        if (reference !== undefined) {
          const refDate = parseTimestamp(reference);
          if (compare !== undefined) {
            const cmpDate = parseTimestamp(compare);
            const deltaMs = cmpDate.getTime() - refDate.getTime();
            result.delta = {
              text: formatDuration(deltaMs),
              ms: deltaMs,
              start: refDate.toISOString(),
              end: cmpDate.toISOString(),
            };
            assistantText = `Delta: ${formatDuration(deltaMs)} (${deltaMs}ms) between ${refDate.toISOString()} and ${cmpDate.toISOString()}`;
          } else {
            const elapsedMs = now.getTime() - refDate.getTime();
            result.elapsed = {
              text: formatDuration(elapsedMs),
              ms: elapsedMs,
              reference: refDate.toISOString(),
            };
            assistantText = `Elapsed: ${formatDuration(elapsedMs)} since ${refDate.toISOString()}`;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Invalid timestamp";
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              action: "time",
              result: { error: message, now: now.toISOString() },
              server_time: new Date().toISOString(),
              assistant_text: `Error: ${message}`,
              debug: { duration_ms: Date.now() - startTime },
            }, null, 2),
          }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            action: "time",
            result,
            server_time: new Date().toISOString(),
            assistant_text: assistantText,
            debug: { duration_ms: Date.now() - startTime },
          }, null, 2),
        }],
      };
    },
  );

  // ── Resources ────────────────────────────────────────────────────────────

  server.resource(
    "ODDKIT Decision Gate",
    "oddkit://instructions",
    { mimeType: "text/plain" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: getInstructionsResource() }],
    }),
  );

  server.resource(
    "ODDKIT Quick Start for Agents",
    "oddkit://quickstart",
    { mimeType: "text/plain" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: getQuickStartResource() }],
    }),
  );

  server.resource(
    "ODDKIT Usage Examples",
    "oddkit://examples",
    { mimeType: "text/plain" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: getExamplesResource() }],
    }),
  );

  // ── Prompts (from baseline registry via ZipBaselineFetcher, cached at module scope)
  //
  // Registry is fetched via ZipBaselineFetcher (R2-cached, content-addressed).
  // Module-level cache (5-min TTL) avoids re-fetching on every MCP request.
  // Prompt content is fetched lazily on prompts/get via the same R2 pipeline.

  try {
    const registry = await fetchPromptsRegistry(env);
    if (registry) {
      for (const inst of registry.instructions.filter((i) => i.audience === "agent")) {
        server.prompt(inst.id, `Agent: ${inst.id} (${inst.uri})`, async () => {
          const text = await fetchPromptContent(env, inst.path);
          if (!text) {
            throw new Error(`Failed to fetch prompt content: ${inst.path}`);
          }
          return {
            messages: [
              {
                role: "user" as const,
                content: { type: "text" as const, text },
              },
            ],
          };
        });
      }
    }
  } catch {
    // Non-fatal: prompts are supplementary. Tools and resources still work.
  }

  return server;
}

// ──────────────────────────────────────────────────────────────────────────────
// Resource content (unchanged from original)
// ──────────────────────────────────────────────────────────────────────────────

function getInstructionsResource(): string {
  return `ODDKIT DECISION GATE

You have access to the \`oddkit\` tool for epistemic governance.

CALL oddkit WHEN:
1. About to implement something → oddkit({ action: "preflight", input: "what you're building" })
2. Have a policy/rules question → oddkit({ action: "search", input: "your question" })
3. Claiming completion → oddkit({ action: "validate", input: "done: what you completed" })
4. Need to understand available docs → oddkit({ action: "catalog", input: "" })
5. Starting a new task → oddkit({ action: "orient", input: "your goal" })
6. Testing a claim → oddkit({ action: "challenge", input: "your claim" })
7. Checking transition → oddkit({ action: "gate", input: "ready to build" })
8. Recording a decision → oddkit({ action: "encode", input: "your decision" })
9. Fetching a specific doc → oddkit({ action: "get", input: "klappy://canon/path" })

DO NOT CALL WHEN:
- Simple file operations with no policy implications
- Continuing work already preflighted
- User explicitly says to skip

The tool returns ready-to-use assistant_text with citations.
Optionally pass \`state\` to enable multi-turn context tracking.`;
}

function getQuickStartResource(): string {
  return `ODDKIT QUICK START FOR AGENTS

You have access to the \`oddkit\` tool for policy retrieval and completion validation.

THREE CRITICAL MOMENTS TO CALL ODDKIT:

1. BEFORE IMPLEMENTING
   Call: oddkit({ action: "preflight", input: "<what you're implementing>" })
   Returns: Start here / Constraints / Definition of Done / Pitfalls

2. WHEN YOU HAVE QUESTIONS
   Call: oddkit({ action: "search", input: "<your question>" })
   Returns: Relevant docs with citations and evidence quotes

3. BEFORE CLAIMING DONE
   Call: oddkit({ action: "validate", input: "done: <what you completed>" })
   Returns: VERIFIED or NEEDS_ARTIFACTS with missing evidence list

RESPONSE HANDLING:
- Use the "assistant_text" field from the response directly
- It contains a complete answer with citations
- Don't add extra narration - the text is ready to use

COMMON PATTERNS:
- Policy question: { action: "search", input: "What is the definition of done?" }
- Preflight: { action: "preflight", input: "add user authentication" }
- Validate: { action: "validate", input: "done: implemented login. Screenshot: login.png" }
- Discovery: { action: "catalog", input: "" }

IMPORTANT: Never pre-inject large documents. Always retrieve on-demand via oddkit.`;
}

function getExamplesResource(): string {
  return `ODDKIT USAGE EXAMPLES

=== SEARCH (policy question) ===
{ action: "search", input: "What evidence is required for UI changes?" }
→ Returns relevant docs with citations and quotes

=== PREFLIGHT (before implementing) ===
{ action: "preflight", input: "implement user authentication with OAuth" }
→ Returns: Start here / Constraints / DoD / Pitfalls

=== VALIDATE (completion) ===
{ action: "validate", input: "done: implemented search. Screenshot: search.png, Tests: passed" }
→ Returns: VERIFIED or NEEDS_ARTIFACTS

=== CATALOG (discovery) ===
{ action: "catalog", input: "" }
→ Returns: doc counts, categories, start-here docs

=== GET (fetch specific doc) ===
{ action: "get", input: "klappy://canon/values/orientation" }
→ Returns: full document content

=== ORIENT (epistemic mode) ===
{ action: "orient", input: "I want to build a new feature" }
→ Returns: mode assessment, assumptions, questions

=== STATE THREADING ===
Call 1: oddkit({ action: "orient", input: "...", state: null })
→ Returns: { ..., state: { phase: "exploration", ... } }
Call 2: oddkit({ action: "challenge", input: "...", state: <state from call 1> })
→ Returns: { ..., state: { phase: "exploration", unresolved: [...], ... } }`;
}

// ──────────────────────────────────────────────────────────────────────────────
// CORS helper (for non-MCP routes; MCP CORS handled by createMcpHandler)
// ──────────────────────────────────────────────────────────────────────────────

function corsHeaders(origin: string = "*"): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, Last-Event-ID",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// HTTP handler
// ──────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    // Redirect to getting started article
    if (url.pathname === "/" && request.method === "GET") {
      return Response.redirect("https://klappy.dev/page/writings/getting-started-with-odd-and-oddkit", 302);
    }

    // MCP server card
    if (url.pathname === "/.well-known/mcp.json" && request.method === "GET") {
      const serverCard = {
        mcpServers: {
          oddkit: {
            url: `${url.origin}/mcp`,
            name: "oddkit",
            version: env.ODDKIT_VERSION || BUILD_VERSION,
            description: "Epistemic governance — policy retrieval, completion validation, and decision capture",
            capabilities: { tools: {}, resources: {}, prompts: {} },
          },
        },
      };
      return new Response(JSON.stringify(serverCard, null, 2), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=300",
          ...corsHeaders(origin),
        },
      });
    }

    // Health check
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          ok: true,
          service: "oddkit",
          version: env.ODDKIT_VERSION || BUILD_VERSION,
          endpoints: { mcp: "/mcp", health: "/health" },
          capabilities: ["tools", "resources", "prompts"],
        }),
        {
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders(origin),
          },
        },
      );
    }

    // ── MCP endpoint ─────────────────────────────────────────────────────────
    // Delegate entirely to createMcpHandler which handles:
    //   - Streamable HTTP transport (MCP 2025-03-26 spec)
    //   - SSE and JSON response formats
    //   - Session management
    //   - GET/POST/DELETE method handling
    //   - CORS for MCP requests
    //   - Error responses in JSON-RPC format
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      const startTime = Date.now();
      const tracer = new RequestTracer();

      // Clone before handler consumes the body
      const telemetryClone =
        env.ODDKIT_TELEMETRY && request.method === "POST"
          ? request.clone()
          : null;

      const server = await createServer(env, tracer);
      const handler = createMcpHandler(server, {
        route: "/mcp",
        corsOptions: {
          origin: origin,
          methods: "GET, POST, DELETE, OPTIONS",
          headers: "Content-Type, Accept, Authorization, Mcp-Session-Id, Last-Event-ID",
          exposeHeaders: "Mcp-Session-Id",
        },
      });
      const response = await handler(request, env, ctx);

      // Phase 1 telemetry — non-blocking, fire-and-forget (E0008)
      // Phase 1.5: cache_tier from tracer feeds blob9 (E0008.1)
      if (telemetryClone) {
        const durationMs = Date.now() - startTime;
        const cacheTier = tracer.indexSource;
        ctx.waitUntil(
          (async () => {
            try {
              const { recordTelemetry } = await import("./telemetry");
              await recordTelemetry(telemetryClone, env, durationMs, cacheTier);
            } catch {
              // Telemetry must never break MCP requests
            }
          })(),
        );
      }

      return response;
    }

    return new Response(renderNotFoundPage(url.pathname, url.origin), {
      status: 404,
      headers: {
        "Content-Type": "text/html;charset=utf-8",
        "Cache-Control": "no-cache",
        ...corsHeaders(origin),
      },
    });
  },
};
