/**
 * Lightweight edge-compatible request tracer for X-Ray performance diagnostics.
 *
 * Adapted from translation-helps-mcp's EdgeXRayTracer. Records every fetch
 * (storage tier access or network call) as a per-fetch fact with timing,
 * cached boolean, optional status and size. The URL prefix carries the tier
 * (memory:// cf-cache:// r2:// build:// or a real https:// URL); there is no
 * separate `source` field on FetchRecord — `cached` is the primary fact, the
 * URL is the breadcrumb.
 *
 * Telemetry derives cache_hits and cache_lookups from the per-fetch records
 * via the `cacheStats` getter — the dashboard does the aggregation, not the
 * tracer. There is no interpretation layer that picks a "winning" tier.
 *
 * `addSpan` is retained for non-fetcher events (action timing, sha:* SHA
 * resolution, anything that is not a storage tier read).
 *
 * Part of E0008: Observability epoch.
 */

export interface TraceSpan {
  label: string;
  duration_ms: number;
  source?: "memory" | "cache" | "r2" | "kv" | "github" | "miss" | "build";
  detail?: string;
}

export interface FetchRecord {
  url: string;
  duration_ms: number;
  cached: boolean;
  status?: number;
  size?: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  total: number;
}

export class RequestTracer {
  private spans: TraceSpan[] = [];
  private fetches: FetchRecord[] = [];
  private startTime: number;

  constructor() {
    this.startTime = performance.now();
  }

  /**
   * Record a non-fetcher span (action timing, SHA resolution, etc.).
   * Storage tier reads should use `recordFetch` instead so they roll into
   * the `cacheStats` arithmetic.
   */
  addSpan(label: string, duration_ms: number, source?: TraceSpan["source"], detail?: string): void {
    this.spans.push({
      label,
      duration_ms: Math.round(duration_ms),
      ...(source ? { source } : {}),
      ...(detail ? { detail } : {}),
    });
  }

  /**
   * Record one storage-tier fetch as a per-fetch fact. URL prefix carries
   * the tier:
   *   - memory://path     → module-level cache hit (always cached: true)
   *   - cf-cache://key    → Cloudflare Cache API
   *   - r2://path         → R2 durable storage
   *   - build://path      → cold rebuild from ZIP
   *   - https://...       → real network fetch (status, size populated)
   *
   * `cached: true` for hits, `cached: false` for misses and live fetches.
   * `cacheStats` aggregates these into hit/miss/total counts; the dashboard
   * does any further per-tier breakdown via debug.trace.fetches[].
   */
  recordFetch(record: FetchRecord): void {
    this.fetches.push({
      ...record,
      duration_ms: Math.round(record.duration_ms),
    });
  }

  /**
   * Time an async operation and record it as a (non-fetch) span.
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
   * Cache-hit arithmetic over the recorded fetches. `total` is the number of
   * fetches; `hits` is the count where `cached === true`. This is what
   * telemetry uses to populate `cache_hits` and `cache_lookups` doubles.
   * Replaces the retired `indexSource` interpretation: no winner is chosen,
   * the dashboard computes hit-rate as `SUM(cache_hits) / SUM(cache_lookups)`.
   */
  get cacheStats(): CacheStats {
    let hits = 0;
    for (const f of this.fetches) if (f.cached) hits++;
    return { hits, misses: this.fetches.length - hits, total: this.fetches.length };
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
    for (const f of this.fetches) {
      const tag = f.cached ? "hit" : "miss";
      parts.push(`fetch=${f.duration_ms}ms(${tag})[${f.url}]`);
    }
    parts.push(`total=${this.elapsed_ms}ms`);
    return parts.join(", ");
  }

  /** Structured JSON for debug envelope inclusion. */
  toJSON(): {
    spans: TraceSpan[];
    fetches: FetchRecord[];
    cacheStats: CacheStats;
    total_ms: number;
  } {
    return {
      spans: [...this.spans],
      fetches: [...this.fetches],
      cacheStats: this.cacheStats,
      total_ms: this.elapsed_ms,
    };
  }

  /** Number of recorded spans (non-fetch). */
  get spanCount(): number {
    return this.spans.length;
  }

  /** Number of recorded fetches. */
  get fetchCount(): number {
    return this.fetches.length;
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
