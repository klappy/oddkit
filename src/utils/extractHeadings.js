/**
 * Extract headings with line numbers from markdown content.
 *
 * Each heading gets a `startLine` and `endLine` representing the region
 * from the heading line to the line before the next heading (or EOF).
 *
 * @param {string} content - Raw markdown content
 * @returns {Array<{ level: number, text: string, startLine: number, endLine: number }>}
 */
export function extractHeadings(content) {
  const lines = content.split("\n");
  const headings = [];
  let currentHeading = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^(#{1,6})\s+(.+)$/);

    if (match) {
      if (currentHeading) {
        currentHeading.endLine = i - 1;
      }

      currentHeading = {
        level: match[1].length,
        text: match[2].trim(),
        startLine: i,
        endLine: lines.length - 1,
      };
      headings.push(currentHeading);
    }
  }

  return headings;
}
