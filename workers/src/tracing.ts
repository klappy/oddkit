/**
 * Lightweight edge-compatible request tracer for X-Ray performance diagnostics.
 *
 * Adapted from aquifer-mcp's RequestTracer (which was modeled on
 * translation-helps-mcp's EdgeXRayTracer). Records every I/O operation
 * with timing, source tier, and optional detail.
 *
 * Usage: create one RequestTracer per inbound request, thread it through
 * storage reads and tool handlers, then serialize via toHeader() or toJSON().
 *
 * Part of E0008: Observability epoch.
 */

export interface TraceSpan {
  label: string;
  duration_ms: number;
  source?: "memory" | "cache" | "r2" | "kv" | "github" | "miss" | "build";
  detail?: string;
}

export class RequestTracer {
  private spans: TraceSpan[] = [];
  private startTime: number;
  private _indexSource: TraceSpan["source"] | null = null;

  constructor() {
    this.startTime = performance.now();
  }

  /** Record a span with explicit timing, source, and detail. */
  addSpan(label: string, duration_ms: number, source?: TraceSpan["source"], detail?: string): void {
    this.spans.push({
      label,
      duration_ms: Math.round(duration_ms),
      ...(source ? { source } : {}),
      ...(detail ? { detail } : {}),
    });

    // Track the primary cache tier for telemetry (first span matching a data
    // fetch). Three label families count:
    //   - "index" / "index-build"  → navigability index fetch (search/orient/etc.)
    //   - "file:*"                 → individual file fetch (oddkit_get fast path)
    // First-wins: actions like runSearch call getIndex *before* getFile, so
    // the index tier wins for those — file:* spans that fire later are
    // ignored. Actions like runGet for klappy:// URIs call getFile only,
    // so the file tier wins. file-r2:* (r2 miss with source="miss") is
    // excluded because "miss" is not a tier.
    if (!this._indexSource && source && source !== "miss") {
      if (
        label === "index" ||
        label === "index-build" ||
        label.startsWith("file:")
      ) {
        this._indexSource = source;
      }
    }
  }

  /**
   * Time an async operation and record it as a span.
   * Returns the operation's result.
   */
  async trace<T>(
    label: string,
    fn: () => Promise<T>,
    source?: TraceSpan["source"],
    detail?: string,
  ): Promise<T> {
    const start = performance.now();
    try {
      const result = await fn();
      this.addSpan(label, performance.now() - start, source, detail);
      return result;
    } catch (err) {
      this.addSpan(label, performance.now() - start, source, `error: ${err}`);
      throw err;
    }
  }

  /**
   * Which storage tier served the primary data fetch for this request.
   * This is the single summary value that feeds telemetry blob9 (cache_tier).
   * "memory" = module-level cache hit (0ms, best case)
   * "cache"  = Cache API edge hit (~1ms)
   * "r2"     = R2 durable storage read (~40ms)
   * "build"  = cold build from ZIP (seconds, worst case)
   * "github" = GitHub network fetch (when no R2/cache layers exist)
   * "none"   = no data fetch happened (e.g. version, time actions)
   *
   * The value reflects the primary fetch — for actions like search/orient
   * that load the navigability index first, this is the index tier. For
   * oddkit_get with a klappy:// URI (the fast path, no index needed), this
   * is the file fetch tier. Either way: where did the work come from?
   */
  get indexSource(): string {
    return this._indexSource ?? "none";
  }

  /** Total elapsed time since tracer creation. */
  get elapsed_ms(): number {
    return Math.round(performance.now() - this.startTime);
  }

  /** Compact header value for X-Oddkit-Trace. */
  toHeader(): string {
    const parts = this.spans.map((s) => {
      let val = `${s.label}=${s.duration_ms}ms`;
      if (s.source) val += `(${s.source})`;
      if (s.detail) val += `[${s.detail}]`;
      return val;
    });
    parts.push(`total=${this.elapsed_ms}ms`);
    return parts.join(", ");
  }

  /** Structured JSON for debug envelope inclusion. */
  toJSON(): { spans: TraceSpan[]; total_ms: number; index_source: string } {
    return { spans: [...this.spans], total_ms: this.elapsed_ms, index_source: this.indexSource };
  }

  /** Number of recorded spans. */
  get spanCount(): number {
    return this.spans.length;
  }
}

/** Shorten a cache/storage key for readable trace output. */
export function shortKey(key: string): string {
  const parts = key.split("/");
  if (parts.length <= 2) return key;
  const mid = parts.slice(1, -1).map((p) => (p.length > 10 ? p.slice(0, 10) + "…" : p)).join("/");
  const last = parts[parts.length - 1]!;
  const shortLast = last.length > 12 ? last.slice(0, 12) + "…" : last;
  return `${parts[0]}/${mid}/${shortLast}`;
}
