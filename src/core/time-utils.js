/**
 * Shared time utility functions for oddkit (E0008.2)
 *
 * Single source of truth for timestamp parsing and duration formatting.
 * Used by both the local Node.js server (actions.js) and the
 * Cloudflare Worker (workers/src/index.ts).
 */

/**
 * Parse a timestamp value into a Date.
 * Accepts ISO 8601 strings, numeric strings, Unix seconds, or Unix milliseconds.
 * Uses a >1e12 heuristic to disambiguate seconds from milliseconds.
 *
 * @param {string | number} input
 * @returns {Date}
 */
export function parseTimestamp(input) {
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

/**
 * Format a duration in milliseconds as a human-readable string.
 * Output: "1d 2h 3m 4s", with negative prefix for negative durations.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  const neg = ms < 0;
  let rem = Math.abs(ms);
  const d = Math.floor(rem / 86400000); rem %= 86400000;
  const h = Math.floor(rem / 3600000); rem %= 3600000;
  const m = Math.floor(rem / 60000); rem %= 60000;
  const s = Math.floor(rem / 1000);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s || parts.length === 0) parts.push(`${s}s`);
  return (neg ? "-" : "") + parts.join(" ");
}
