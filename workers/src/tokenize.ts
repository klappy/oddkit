/**
 * Tokenizer module for oddkit MCP Worker telemetry (E0008).
 *
 * Provides cl100k_base token counts for request and response payloads.
 * cl100k_base is GPT-4's tokenizer; we use it as a tokenizer-agnostic
 * proxy for "payload token shape," not as a billing-accurate measure
 * for any specific consumer model.
 *
 * Choice of cl100k_base over @anthropic-ai/tokenizer: the cl100k bundle
 * benchmarks ~6x faster (median 0.05–1.3ms across 200B–50KB payloads on
 * Node v8, the same engine as Cloudflare Workers) and has dramatically
 * better p95 (no WASM memory-grow spikes). Token counts diverge from the
 * Claude tokenizer by ~3–4% on English prose — acceptable noise floor
 * for shape analysis. See `klappy://canon/constraints/measure-before-you-object`
 * for the bench methodology that drove this choice.
 *
 * Bundle impact: ~432 KB gzipped via the `gpt-tokenizer/encoding/cl100k_base`
 * subpath import. Loaded via dynamic import so cold paths that don't
 * tokenize don't pay the parse cost.
 *
 * Failure mode: if the tokenizer fails to load or throws on a payload,
 * `countTokensSafe` returns null. Telemetry treats null as "not measured"
 * and writes `0` to keep the schema dense; the absence is visible in the
 * tokenize_ms column being 0 alongside non-zero bytes.
 *
 * See: klappy://canon/constraints/telemetry-governance
 */

type CountTokensFn = (text: string) => number;

let encoderPromise: Promise<CountTokensFn | null> | null = null;

/**
 * Lazily import gpt-tokenizer's cl100k_base encoder. Cached across requests
 * via the module-level promise; the first call within a worker isolate pays
 * the parse cost, all subsequent calls are warm.
 */
function getEncoder(): Promise<CountTokensFn | null> {
  if (encoderPromise) return encoderPromise;

  encoderPromise = import("gpt-tokenizer/encoding/cl100k_base")
    .then((mod) => {
      const fn = (mod as { countTokens?: CountTokensFn }).countTokens;
      if (typeof fn !== "function") return null;
      return fn;
    })
    .catch(() => null);

  return encoderPromise;
}

/**
 * Count cl100k_base tokens in `text`. Returns null on any failure
 * (load failure, encoder throw, etc). Telemetry must never break MCP
 * requests — this function never throws.
 */
export async function countTokensSafe(text: string): Promise<number | null> {
  if (!text) return 0;
  try {
    const fn = await getEncoder();
    if (!fn) return null;
    return fn(text);
  } catch {
    return null;
  }
}

/**
 * Result of measuring a payload pair. All fields default to 0 on failure
 * so the telemetry schema stays dense; the `tokenize_ms` field carries
 * the signal — a value of 0 alongside non-zero bytes indicates the
 * tokenizer was skipped or failed.
 */
export interface PayloadShape {
  bytes_in: number;
  bytes_out: number;
  tokens_in: number;
  tokens_out: number;
  tokenize_ms: number;
}

/**
 * Measure the byte and token shape of a request/response pair. Tokenization
 * is performed once per payload using the lazy-loaded cl100k_base encoder.
 * Bytes are measured via TextEncoder (UTF-8 byte length, the wire size).
 */
export async function measurePayloadShape(
  requestText: string,
  responseText: string,
): Promise<PayloadShape> {
  const encoder = new TextEncoder();
  const bytes_in = requestText ? encoder.encode(requestText).length : 0;
  const bytes_out = responseText ? encoder.encode(responseText).length : 0;

  const start = performance.now();
  const [tIn, tOut] = await Promise.all([
    countTokensSafe(requestText),
    countTokensSafe(responseText),
  ]);
  const tokenize_ms = Math.round((performance.now() - start) * 1000) / 1000;

  // A `0` from countTokensSafe on empty text is a trivial short-circuit, not
  // a real tokenization — only a non-null result on non-empty text proves the
  // encoder ran. If neither payload was actually tokenized, zero out
  // tokenize_ms to preserve the documented "skipped/failed" signal.
  const tokenizerRan =
    (requestText !== "" && tIn !== null) ||
    (responseText !== "" && tOut !== null);

  return {
    bytes_in,
    bytes_out,
    tokens_in: tIn ?? 0,
    tokens_out: tOut ?? 0,
    tokenize_ms: tokenizerRan ? tokenize_ms : 0,
  };
}

/**
 * Measure the byte and token shape of a Request/Response pair using the
 * call-site Response object directly. Clones the response so the original
 * body flows untouched back to the caller, reads the clone to completion,
 * then delegates to `measurePayloadShape`.
 *
 * No Content-Type filter — the original implementation guessed that MCP
 * responses would be `application/json` and recorded zeros for everything
 * else. Real MCP traffic uses Streamable HTTP transport which returns
 * `text/event-stream`, and the prior filter dropped almost every response.
 * Reading the body universally is correct because oddkit's responses are
 * always bounded (no long-lived streams), and the SSE protocol overhead
 * (~10 bytes per event) is negligible against the actual payload size.
 *
 * Telemetry must never break MCP requests — clone or read failures fall
 * through to an empty `responseText`, which `measurePayloadShape` handles
 * by recording `bytes_out=0, tokens_out=0`.
 */
export async function measureResponseShape(
  requestText: string,
  response: Response,
): Promise<PayloadShape> {
  let responseText = "";
  try {
    responseText = await response.clone().text();
  } catch {
    // Fall through with empty string; bytes_out / tokens_out will be 0.
  }
  return measurePayloadShape(requestText, responseText);
}
