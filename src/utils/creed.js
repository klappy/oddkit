/**
 * Extract creed lines from canon/values/orientation.md content.
 *
 * Parses the "## The Creed" section and returns an array of creed lines.
 * Returns null if the section is not found or contains no qualifying lines.
 *
 * Qualifying lines: non-empty, not headings (#), not blockquotes (>),
 * not HTML comments (<!--), and not horizontal rules (---).
 *
 * NOTE: A copy of this logic exists in workers/src/orchestrate.ts
 * (TypeScript, Cloudflare Worker runtime). If parsing rules change here,
 * update the Worker copy too.
 */
export function extractCreedLines(content) {
  const lines = content.split("\n");
  const startIdx = lines.findIndex((l) => /^##\s+The Creed/.test(l));
  if (startIdx === -1) return null;
  const creedLines = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    const trimmed = lines[i].trim();
    if (trimmed && !trimmed.startsWith(">") && !trimmed.startsWith("#") && !trimmed.startsWith("<!--") && !/^-{3,}$/.test(trimmed)) {
      creedLines.push(trimmed);
    }
  }
  return creedLines.length > 0 ? creedLines : null;
}
