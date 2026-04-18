/**
 * Shared markdown parsing helpers.
 *
 * Keep this module dependency-free so it can be imported from any code path
 * (orchestrate, index, future canon readers) without pulling in unrelated
 * state. Every helper here must be pure and stateless.
 */

/**
 * Parse a single markdown table row into trimmed cell values, preserving
 * legitimately-empty middle cells. Only the leading and trailing empty strings
 * produced by splitting a `| a | b |`-style row are stripped — a prior
 * `.filter(c => c.length > 0)` approach also dropped empty interior cells,
 * which silently collapsed the column count and caused `cols.length >= N`
 * guards to misfire (e.g. a voice-dump row with an empty tiers cell).
 */
export function parseTableRow(row: string): string[] {
  const parts = row.split("|");
  // Strip the leading empty produced by a leading `|`, if present
  if (parts.length > 0 && parts[0].trim() === "") parts.shift();
  // Strip the trailing empty produced by a trailing `|`, if present
  if (parts.length > 0 && parts[parts.length - 1].trim() === "") parts.pop();
  return parts.map((c) => c.trim());
}
