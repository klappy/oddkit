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
 *   blob8: worker_version — oddkit semver string. Sourced from env.ODDKIT_VERSION
 *                            (deploy-time injection) with a build-time fallback
 *                            to workers/package.json::version. Never "unknown"
 *                            on a normal deploy.
 *   blob9: cache_tier    — which storage tier served the index (E0008.1)
 *   double1: count        — always 1 (for SUM aggregation)
 *   double2: duration_ms  — Full MCP request wall-clock, measured at the worker
 *                            edge from request entry through handler return.
 *                            Includes V8 cold-start, KB fetch, MCP SDK overhead,
 *                            and action handler compute. NOT the same as the
 *                            per-action `debug.duration_ms` returned in tool
 *                            envelopes — that field measures only the action
 *                            handler's internal compute. Expect a long tail on
 *                            cache-miss requests even for trivial actions like
 *                            oddkit_time.
 *   double3: bytes_in     — UTF-8 byte length of the JSON-RPC request body.
 *                            0 when telemetry was unable to read the body.
 *                            Tokenizer-agnostic; exact wire size.
 *   double4: bytes_out    — UTF-8 byte length of the response body. 0 for
 *                            streamed responses (SSE) where the body cannot be
 *                            measured without consuming the stream.
 *   double5: tokens_in    — cl100k_base token count of the request body.
 *                            See `tokenize.ts` for the tokenizer-choice rationale.
 *                            0 when tokenization was skipped or failed.
 *   double6: tokens_out   — cl100k_base token count of the response body. 0 for
 *                            streamed responses or tokenizer failure.
 *
 *   NOTE: a previous iteration shipped a `double7: tokenize_ms` field intended
 *   to capture the wall-clock cost of tokenization for bench-vs-prod
 *   comparison. It is gone. Cloudflare Workers freezes both
 *   `performance.now()` and `Date.now()` between network I/O events as a
 *   timing-side-channel mitigation, so any timing of pure CPU work always
 *   reads 0 in production. The cost was characterized in the bench (workers/
 *   test/tokenize.test.mjs) and bytes_in/out + tokens_in/out are sufficient
 *   to predict per-call cost from that bench curve.
 *
 *   index1: sampling_key  — consumer label (for sampling consistency)
 *
 * See: klappy://canon/constraints/telemetry-governance
 */

import type { Env } from "./zip-baseline-fetcher";
import { KnowledgeBaseFetcher } from "./zip-baseline-fetcher";
import type { PayloadShape } from "./tokenize";
import pkg from "../package.json";

// Build-time fallback for blob8 (worker_version). env.ODDKIT_VERSION is
// injected via `--var ODDKIT_VERSION:...` when deploying through the
// `npm run deploy` script, but Cloudflare's auto-deploy from GitHub does
// not execute that script — it invokes wrangler directly with the config
// in wrangler.toml, leaving env.ODDKIT_VERSION undefined. Falling back to
// pkg.version (read from workers/package.json at build time) gives
// telemetry a real version string under the canonical deploy path.
const BUILD_VERSION = pkg.version;

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
 *
 * Caller responsibilities:
 *   - Pass the raw request body as `requestBody` (string). Already-cloned and
 *     read; this function will parse it as JSON-RPC.
 *   - Pass the original `request` so consumer-label resolution can read URL
 *     params and headers.
 *   - Pass `shape` describing the payload byte and token shape, or null to
 *     write zeros for the shape doubles (e.g. when the response could not be
 *     measured because it was an SSE stream).
 */
export function recordTelemetry(
  request: Request,
  requestBody: string,
  env: Env,
  durationMs: number,
  cacheTier?: string,
  shape?: PayloadShape | null,
): void {
  if (!env.ODDKIT_TELEMETRY) return;

  let body: unknown;
  try {
    body = JSON.parse(requestBody);
  } catch {
    // Malformed JSON-RPC — silently drop, telemetry must never break MCP requests
    return;
  }

  // Handle batch requests — process each message
  const messages = Array.isArray(body) ? body : [body];

  // Bytes/tokens are per-request (not per-message); for batches we attribute
  // the full payload shape to each message rather than fabricating a split.
  const bytesIn = shape?.bytes_in ?? 0;
  const bytesOut = shape?.bytes_out ?? 0;
  const tokensIn = shape?.tokens_in ?? 0;
  const tokensOut = shape?.tokens_out ?? 0;

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
        env.ODDKIT_VERSION || BUILD_VERSION,
        cacheTier || "none", // blob9: E0008.1 x-ray cache tier
      ],
      doubles: [
        1,                // double1: count
        durationMs,       // double2: duration_ms
        bytesIn,          // double3: bytes_in
        bytesOut,         // double4: bytes_out
        tokensIn,         // double5: tokens_in
        tokensOut,        // double6: tokens_out
      ],
      indexes: [consumerLabel],
    });
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Semantic schema mapping (vodka-architecture compliant)
//
// Cloudflare Analytics Engine uses positional slot names (blob1..9, double1..6).
// Consumers see semantic names only. This module:
//   1. Loads the authoritative mapping from canon at runtime
//      (canon/constraints/telemetry-governance.md, parsed via KnowledgeBaseFetcher)
//   2. Falls back to the hardcoded baseline below if canon is unreachable
//   3. Rewrites consumer SQL (semantic → raw) before forwarding to CF
//   4. Rewrites result column names (raw → semantic) before returning to consumer
//   5. Rejects any query containing raw blob*/double* names with a helpful error
//
// Source of truth: klappy://canon/constraints/telemetry-governance
// ──────────────────────────────────────────────────────────────────────────────

export interface SchemaMap {
  /** raw slot name → semantic name (e.g. blob1 → event_type) */
  rawToSemantic: Map<string, string>;
  /** semantic name → raw slot name (e.g. event_type → blob1) */
  semanticToRaw: Map<string, string>;
}

/**
 * Canonical blob→semantic ordering derived from canon table
 * "Structural Dimensions (Blobs)" (positional, 9 entries).
 * The canon doc uses human-readable dimension names in that table, not
 * machine-readable column identifiers, so positional order is the only
 * reliable parse signal. These names mirror what the tool docstring exposes.
 */
const BASELINE_BLOB_SEMANTIC_NAMES = [
  "event_type",       // blob1
  "method",           // blob2
  "tool_name",        // blob3
  "consumer_label",   // blob4
  "consumer_source",  // blob5
  "knowledge_base_url", // blob6
  "document_uri",     // blob7
  "worker_version",   // blob8
  "cache_tier",       // blob9
] as const;

/**
 * Baseline double→semantic names. Canon table "Numeric Values (Doubles)"
 * encodes these with backtick-quoted identifiers (except "Count" → "count")
 * which are parseable at runtime. Baseline is the safety net.
 */
const BASELINE_DOUBLE_SEMANTIC_NAMES = [
  "count",       // double1
  "duration_ms", // double2
  "bytes_in",    // double3
  "bytes_out",   // double4
  "tokens_in",   // double5
  "tokens_out",  // double6
] as const;

/** Build a SchemaMap from ordered blob/double name arrays. Exported for unit testing. */
export function buildSchemaMapFromArrays(
  blobNames: readonly string[],
  doubleNames: readonly string[],
): SchemaMap {
  const rawToSemantic = new Map<string, string>();
  const semanticToRaw = new Map<string, string>();

  blobNames.forEach((name, i) => {
    const slot = `blob${i + 1}`;
    rawToSemantic.set(slot, name);
    semanticToRaw.set(name, slot);
  });

  doubleNames.forEach((name, i) => {
    const slot = `double${i + 1}`;
    rawToSemantic.set(slot, name);
    semanticToRaw.set(name, slot);
  });

  return { rawToSemantic, semanticToRaw };
}

/**
 * Attempt to parse semantic double names from the canon governance document.
 * The "Numeric Values (Doubles)" table in canon uses backtick-quoted identifiers
 * in the "Value" column (e.g. `duration_ms`, `bytes_in`). Row 1 uses "Count"
 * (unquoted) which we lowercase to "count".
 *
 * Returns null if the section is missing or has too few rows to be trusted.
 */
function parseDoublesFromCanon(content: string): string[] | null {
  // Match the Numeric Values section up to the next ## or ### heading
  const sectionMatch = content.match(
    /###\s+Numeric Values \(Doubles\)([\s\S]*?)(?=\n###|\n##|$)/,
  );
  if (!sectionMatch) return null;

  const section = sectionMatch[1];

  // Match table data rows: | # | Value | ...
  // Value may be plain text (Count) or backtick-quoted (`duration_ms`)
  const rowPattern = /^\|\s*\d+\s*\|\s*(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)\s*\|/gm;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = rowPattern.exec(section)) !== null) {
    const raw = m[1].replace(/`/g, "").trim().toLowerCase();
    names.push(raw);
  }

  // Sanity: must match expected baseline count
  if (names.length !== BASELINE_DOUBLE_SEMANTIC_NAMES.length) return null;

  return names;
}

/** Module-level cache — reset between Worker isolate restarts (Cloudflare normal). */
let cachedSchemaMap: SchemaMap | null = null;

/**
 * Return the schema map, loading from canon on first call.
 * Canon-derived doubles names take precedence over baseline; blob names are
 * always positional from the baseline (the canon table uses human-readable
 * dimension names, not machine-readable identifiers).
 */
async function getSchemaMap(env: Env): Promise<SchemaMap> {
  if (cachedSchemaMap) return cachedSchemaMap;

  let doubleNames: readonly string[] = BASELINE_DOUBLE_SEMANTIC_NAMES;

  try {
    const fetcher = new KnowledgeBaseFetcher(env);
    const content = await fetcher.getFile(
      "canon/constraints/telemetry-governance.md",
    );
    if (content) {
      const parsed = parseDoublesFromCanon(content);
      if (parsed) {
        doubleNames = parsed;
      }
    }
  } catch {
    // Canon unreachable — fall through to baseline (vodka architecture safety net)
  }

  cachedSchemaMap = buildSchemaMapFromArrays(
    BASELINE_BLOB_SEMANTIC_NAMES,
    doubleNames,
  );
  return cachedSchemaMap;
}

// ──────────────────────────────────────────────────────────────────────────────
// SQL query rewriting
// ──────────────────────────────────────────────────────────────────────────────

/** Raw slot name pattern — used to detect forbidden column references. */
const RAW_SLOT_PATTERN = /\b(blob[1-9]|double[1-9])\b/gi;

/**
 * Reject queries that contain raw slot names (blob1..9 / double1..6).
 * Returns an error message string, or null if the query is clean.
 *
 * Single-quoted string literals are skipped so that values like
 * `'https://example.com/blob1/readme'` do not trigger a false rejection.
 * This matches the scoping rules used by `rewriteSqlToRaw`. SQL's
 * doubled-quote escape (`''`) is respected so that escaped quotes do not
 * terminate the literal prematurely.
 * Exported for unit testing.
 */
export function detectRawSlotNames(
  sql: string,
  schemaMap: SchemaMap,
): string | null {
  // Strip single-quoted string literals before scanning for raw slot names
  // so filter values containing substrings like `blob1` are not flagged.
  const literalPattern = /'(?:[^']|'')*'/g;
  const scannable = sql.replace(literalPattern, "''");
  const matches = scannable.match(RAW_SLOT_PATTERN);
  if (!matches) return null;

  const unique = [...new Set(matches.map((m) => m.toLowerCase()))];
  const suggestions = unique
    .map((raw) => {
      const semantic = schemaMap.rawToSemantic.get(raw);
      return semantic ? `\`${raw}\` → \`${semantic}\`` : `\`${raw}\` (unmapped)`;
    })
    .join(", ");

  return (
    `Raw column names are not allowed. Use semantic names instead: ${suggestions}. ` +
    `See the telemetry_public tool description for the full schema.`
  );
}

/**
 * Rewrite a SQL query from semantic names to raw Analytics Engine slot names.
 * Semantic names are matched on word boundaries to avoid partial replacements.
 * Longer names are replaced first to prevent prefix collisions (e.g.
 * knowledge_base_url vs url).
 *
 * A negative lookahead `(?!\s*\()` prevents rewriting identifiers that are
 * immediately followed by an opening parenthesis — i.e. SQL function calls.
 * This is required because the semantic name `count` collides with the SQL
 * aggregate `count()`; without the guard, `count(*)` would become
 * `double1(*)` and be rejected by the CF API. Column references never
 * take a `(` after them, so this is safe for all semantic names.
 *
 * Single-quoted string literals are skipped so that values like
 * `'klappy://sources/scientific-method'` are not corrupted (word boundaries
 * around `-` / `/` would otherwise cause `method` to be rewritten to the raw
 * slot name inside the literal). SQL's doubled-quote escape (`''`) is
 * respected so that escaped quotes do not terminate the literal prematurely.
 * Exported for unit testing.
 */
export function rewriteSqlToRaw(sql: string, schemaMap: SchemaMap): string {
  // Sort by semantic name length descending to avoid prefix collisions
  const entries = [...schemaMap.semanticToRaw.entries()].sort(
    (a, b) => b[0].length - a[0].length,
  );

  const rewriteSegment = (segment: string): string => {
    let out = segment;
    for (const [semantic, raw] of entries) {
      // \b word-boundary anchors prevent partial matches inside longer identifiers.
      // Negative lookahead (?!\s*\() skips function-call positions (e.g. count(*)).
      const pattern = new RegExp(`\\b${semantic}\\b(?!\\s*\\()`, "g");
      out = out.replace(pattern, raw);
    }
    return out;
  };

  // Split SQL into alternating non-literal and single-quoted literal segments.
  // Only non-literal segments are subject to rewriting, so user-supplied
  // filter values passed as string literals are preserved verbatim.
  const literalPattern = /'(?:[^']|'')*'/g;
  let rewritten = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = literalPattern.exec(sql)) !== null) {
    rewritten += rewriteSegment(sql.slice(lastIndex, match.index));
    rewritten += match[0];
    lastIndex = match.index + match[0].length;
  }
  rewritten += rewriteSegment(sql.slice(lastIndex));
  return rewritten;
}

/**
 * Rewrite result column names from raw slot names back to semantic names.
 * Operates on the `meta` array (CF Analytics Engine response format) and
 * rewrites the corresponding keys in each `data` row.
 * Exported for unit testing.
 */
export function rewriteResultToSemantic(
  result: unknown,
  schemaMap: SchemaMap,
): unknown {
  if (typeof result !== "object" || result === null) return result;

  const r = result as Record<string, unknown>;
  if (!Array.isArray(r.meta)) return result;

  type MetaCol = { name: string; type: string };
  const oldMeta = r.meta as MetaCol[];

  // Build a remapping from old column name → semantic name (only for slots)
  const colRemap = new Map<string, string>();
  const newMeta: MetaCol[] = oldMeta.map((col) => {
    const semantic = schemaMap.rawToSemantic.get(col.name);
    if (semantic && semantic !== col.name) {
      colRemap.set(col.name, semantic);
      return { ...col, name: semantic };
    }
    return col;
  });

  if (colRemap.size === 0) return result; // nothing to rename

  // Rewrite data rows
  const newData = Array.isArray(r.data)
    ? (r.data as Array<Record<string, unknown>>).map((row) => {
        const newRow: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(row)) {
          newRow[colRemap.get(key) ?? key] = val;
        }
        return newRow;
      })
    : r.data;

  return { ...r, meta: newMeta, data: newData };
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
 * Query Analytics Engine SQL API with semantic-name rewriting.
 * Used by telemetry_public tool.
 * Requires CF_ACCOUNT_ID and CF_API_TOKEN env vars.
 * Only permits SELECT queries against the oddkit_telemetry dataset.
 *
 * Semantic-name contract:
 *   - Consumers write SQL using semantic names (event_type, tool_name, etc.)
 *   - Raw slot names (blob1, double2, etc.) are rejected with a helpful error
 *   - The schema mapping is loaded from canon at runtime; the hardcoded baseline
 *     is the safety net when canon is unreachable (vodka architecture)
 *   - Result columns are renamed from raw slots back to semantic names
 */
export async function queryTelemetry(env: Env, query: string): Promise<unknown> {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
    return {
      error: "Telemetry queries not configured (missing CF_ACCOUNT_ID or CF_API_TOKEN)",
    };
  }

  // Load schema map (canon-first, baseline fallback)
  const schemaMap = await getSchemaMap(env);

  // Reject raw slot names before any other validation
  const rawSlotError = detectRawSlotNames(query, schemaMap);
  if (rawSlotError) {
    return { error: rawSlotError };
  }

  // Rewrite semantic names → raw slot names for the CF API
  const rawQuery = rewriteSqlToRaw(query, schemaMap);

  const validationError = validateTelemetryQuery(rawQuery);
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
      body: rawQuery,
    },
  );

  const result = await response.json();

  // Rewrite result column names from raw slots back to semantic names
  return rewriteResultToSemantic(result, schemaMap);
}
