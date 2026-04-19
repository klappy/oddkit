/**
 * Telemetry module for oddkit MCP Worker (Phase 1 — E0008)
 *
 * Non-blocking write of one Analytics Engine data point per JSON-RPC message.
 * Tracks structural identifiers only (tool names, methods, repo URLs, document paths).
 * Never records search queries, document content, model responses, or raw prompts.
 *
 * Data point schema:
 *   blob1: event_type     — "mcp_request" or "tool_call"
 *   blob2: method         — JSON-RPC method (e.g. "tools/call")
 *   blob3: tool_name      — oddkit action name (e.g. "orient", "search")
 *   blob4: consumer_label — best-effort identity (e.g. "Claude-User", "unknown")
 *   blob5: consumer_source — how label was resolved (e.g. "user-agent")
 *   blob6: knowledge_base_url — which repo is being served
 *   blob7: document_uri   — for get calls, the URI requested
 *   blob8: worker_version — oddkit version string
 *   blob9: cache_tier    — which storage tier served the index (E0008.1)
 *   double1: count        — always 1 (for SUM aggregation)
 *   double2: duration_ms  — MCP request processing time (measured by caller)
 *   index1: sampling_key  — consumer label (for sampling consistency)
 *
 * See: klappy://canon/constraints/telemetry-governance
 */

import type { Env } from "./zip-baseline-fetcher";

// ──────────────────────────────────────────────────────────────────────────────
// Sanitization
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Sanitize a consumer label: trim, collapse whitespace, truncate to fit
 * Analytics Engine's 96-byte index limit.
 * Returns empty string for null/undefined/whitespace-only input.
 */
function sanitize(raw: string | null | undefined): string {
  if (!raw) return "";
  let cleaned = raw.trim().replace(/\s+/g, " ").slice(0, 96);
  const encoder = new TextEncoder();
  while (cleaned.length > 0 && encoder.encode(cleaned).length > 96) {
    cleaned = cleaned.slice(0, -1);
  }
  return cleaned;
}

// ──────────────────────────────────────────────────────────────────────────────
// Consumer label resolution
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Extract clientInfo.name from an MCP initialize payload.
 * Returns null if the payload is not an initialize message or has no clientInfo.
 */
function parseClientInfoName(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || !("method" in payload)) {
    return null;
  }

  const msg = payload as Record<string, unknown>;
  if (msg.method !== "initialize") return null;

  const params = msg.params;
  if (typeof params !== "object" || params === null) return null;

  const p = params as Record<string, unknown>;
  const clientInfo = p.clientInfo;
  if (typeof clientInfo !== "object" || clientInfo === null) return null;

  const ci = clientInfo as Record<string, unknown>;
  const name = ci.name;
  if (typeof name === "string" && name.trim()) {
    return sanitize(name);
  }

  return null;
}

/**
 * Consumer label resolution chain:
 * 1. ?consumer= query parameter (URL-level, highest priority)
 * 2. x-oddkit-client header (explicit)
 * 3. MCP initialize → clientInfo.name (protocol-native)
 * 4. User-Agent header (fallback)
 * 5. "unknown" (default)
 */
export function parseConsumerLabel(
  request: Request,
  payload: unknown,
): { label: string; source: string } {
  // 1. URL query parameter — lets platforms that block custom headers self-identify
  const url = new URL(request.url);
  const consumer = url.searchParams.get("consumer");
  if (consumer) {
    const label = sanitize(consumer);
    if (label) return { label, source: "query-param" };
  }

  // 2. Explicit header
  const explicit = request.headers.get("x-oddkit-client");
  if (explicit) {
    const label = sanitize(explicit);
    if (label) return { label, source: "x-oddkit-client" };
  }

  // 3. MCP initialize clientInfo.name
  const fromInit = parseClientInfoName(payload);
  if (fromInit) return { label: fromInit, source: "initialize.clientInfo.name" };

  // 4. User-Agent
  const ua = request.headers.get("user-agent");
  if (ua) {
    const first = ua.split(/\s+/)[0] ?? "";
    const cleaned = sanitize(first);
    if (cleaned && cleaned !== "unknown") {
      return { label: cleaned, source: "user-agent" };
    }
  }

  return { label: "unknown", source: "unknown" };
}

// ──────────────────────────────────────────────────────────────────────────────
// Tool call parsing
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Extract tool call details from JSON-RPC payload.
 * Returns null if not a tools/call message.
 */
export function parseToolCall(payload: unknown): {
  method: string;
  toolName: string;
  documentUri: string;
  knowledgeBaseUrl: string;
} | null {
  if (typeof payload !== "object" || payload === null || !("method" in payload)) {
    return null;
  }

  const msg = payload as Record<string, unknown>;
  const method = typeof msg.method === "string" ? msg.method : "";

  if (method !== "tools/call") return null;

  const params = msg.params;
  if (typeof params !== "object" || params === null) {
    return { method, toolName: "", documentUri: "", knowledgeBaseUrl: "" };
  }

  const p = params as Record<string, unknown>;
  const toolName = typeof p.name === "string" ? p.name : "";

  // Extract details from tool arguments
  let documentUri = "";
  let knowledgeBaseUrl = "";
  const args = p.arguments;
  if (typeof args === "object" && args !== null) {
    const a = args as Record<string, unknown>;
    // Unified oddkit tool uses "input" for URI on get action
    if (typeof a.input === "string" && a.input.includes("://")) {
      documentUri = a.input;
    }
    // Extract knowledge base URL from tool arguments
    if (typeof a.knowledge_base_url === "string" && a.knowledge_base_url) {
      knowledgeBaseUrl = a.knowledge_base_url;
    }
  }

  return { method, toolName, documentUri, knowledgeBaseUrl };
}

// ──────────────────────────────────────────────────────────────────────────────
// Telemetry recording
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Record one telemetry data point per JSON-RPC message.
 * Non-blocking — uses env.ODDKIT_TELEMETRY.writeDataPoint() which requires
 * no await (fire-and-forget via Analytics Engine).
 * Called with a cloned request to avoid consuming the original body.
 */
export function recordTelemetry(request: Request, env: Env, durationMs: number, cacheTier?: string): Promise<void> {
  if (!env.ODDKIT_TELEMETRY) return Promise.resolve();

  // Parse the request body to extract JSON-RPC details
  return request
    .json()
    .then((body: unknown) => {
      // Handle batch requests — process each message
      const messages = Array.isArray(body) ? body : [body];

      for (const payload of messages) {
        const { label: consumerLabel, source: consumerSource } = parseConsumerLabel(
          request,
          payload,
        );
        const toolCall = parseToolCall(payload);

        const msg =
          typeof payload === "object" && payload !== null
            ? (payload as Record<string, unknown>)
            : {};
        const method = typeof msg.method === "string" ? msg.method : "unknown";

        const eventType = toolCall ? "tool_call" : "mcp_request";
        const toolName = toolCall?.toolName ?? "";
        const documentUri = toolCall?.documentUri ?? "";

        env.ODDKIT_TELEMETRY!.writeDataPoint({
          blobs: [
            eventType,
            method,
            toolName,
            consumerLabel,
            consumerSource,
            toolCall?.knowledgeBaseUrl || env.DEFAULT_KNOWLEDGE_BASE_URL || "",
            documentUri,
            env.ODDKIT_VERSION || "unknown",
            cacheTier || "none", // blob9: E0008.1 x-ray cache tier
          ],
          doubles: [1, durationMs],
          indexes: [consumerLabel],
        });
      }
    })
    .catch(() => {
      // Telemetry must never break MCP requests — silently drop parse failures
    });
}

// ──────────────────────────────────────────────────────────────────────────────
// Analytics Engine SQL query
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Validate that a SQL query only targets the oddkit_telemetry dataset.
 * Rejects SHOW, non-SELECT statements, and queries referencing other tables.
 */
function validateTelemetryQuery(query: string): string | null {
  const normalized = query.replace(/\s+/g, " ").trim();
  if (!/^\s*SELECT\b/i.test(normalized)) {
    return "Only SELECT queries are allowed";
  }
  if (normalized.includes(";")) {
    return "Multiple statements are not allowed";
  }
  const fromJoinPattern = /\b(?:FROM|JOIN)\s+/gi;
  const tableIdPattern = /^(?:"([^"]+)"|`([^`]+)`|([a-zA-Z_][a-zA-Z0-9_]*))/;
  const commaTablePattern = /^\s*,\s*(?:"([^"]+)"|`([^`]+)`|([a-zA-Z_][a-zA-Z0-9_]*))/;
  const tables: string[] = [];
  let fjMatch: RegExpExecArray | null;
  while ((fjMatch = fromJoinPattern.exec(normalized)) !== null) {
    let rest = normalized.slice(fjMatch.index + fjMatch[0].length);
    const first = tableIdPattern.exec(rest);
    if (!first) continue;
    tables.push((first[1] ?? first[2] ?? first[3]).toLowerCase());
    rest = rest.slice(first[0].length);
    let ct: RegExpExecArray | null;
    while ((ct = commaTablePattern.exec(rest)) !== null) {
      tables.push((ct[1] ?? ct[2] ?? ct[3]).toLowerCase());
      rest = rest.slice(ct[0].length);
    }
  }
  if (tables.length === 0) {
    return "Query must include a FROM clause";
  }
  for (const table of tables) {
    if (table !== "oddkit_telemetry") {
      return `Query may only reference the oddkit_telemetry dataset, found: ${table}`;
    }
  }
  return null;
}

/**
 * Query Analytics Engine SQL API.
 * Used by telemetry_public tool.
 * Requires CF_ACCOUNT_ID and CF_API_TOKEN env vars.
 * Only permits SELECT queries against the oddkit_telemetry dataset.
 */
export async function queryTelemetry(env: Env, query: string): Promise<unknown> {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
    return {
      error: "Telemetry queries not configured (missing CF_ACCOUNT_ID or CF_API_TOKEN)",
    };
  }

  const validationError = validateTelemetryQuery(query);
  if (validationError) {
    return { error: validationError };
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        "Content-Type": "text/plain",
      },
      body: query,
    },
  );

  return response.json();
}
