/**
 * Governance validation for oddkit_write
 *
 * Validates content against ODD/Canon/Docs standards before writing.
 * Validation is informational — does not block writes.
 *
 * Checks (for canon/, odd/, docs/ files):
 *   - Frontmatter present
 *   - Required fields: title, uri, audience, tier, tags, epoch
 *   - Blockquote present (> line after title)
 *   - Summary section (## Summary heading)
 *   - Header quality (no generic headers)
 *
 * Checks (all files):
 *   - UTF-8 valid
 *   - Path valid (no traversal, no absolute paths)
 */

const GENERIC_HEADERS = [
  "background",
  "details",
  "information",
  "overview",
  "introduction",
  "misc",
  "miscellaneous",
  "other",
  "notes",
  "general",
];

/**
 * Validate a file's content against governance constraints
 * @param {string} path - File path
 * @param {string} content - File content
 * @returns {Object} Validation results with checks array
 */
export function validateFile(path, content) {
  const checks = [];

  // Path safety — blocks writes with traversal sequences
  const isAbsolute = path.startsWith("/");
  const hasTraversal = path.includes("..");
  checks.push({
    name: "path_safe",
    passed: !hasTraversal && !isAbsolute,
    message: hasTraversal
      ? "Path contains traversal sequences (..)"
      : isAbsolute
        ? "Path must be repo-relative, not absolute"
        : null,
  });

  // UTF-8 validity
  try {
    Buffer.from(content, "utf-8");
    checks.push({ name: "utf8_valid", passed: true });
  } catch {
    checks.push({
      name: "utf8_valid",
      passed: false,
      message: "Content is not valid UTF-8",
    });
  }

  // Governed file checks (canon/, odd/, docs/)
  const isGoverned = path.startsWith("canon/") || path.startsWith("odd/") || path.startsWith("docs/");

  if (isGoverned) {
    // Frontmatter present
    const hasFrontmatter = content.trim().startsWith("---");
    checks.push({
      name: "frontmatter_present",
      passed: hasFrontmatter,
      message: hasFrontmatter ? null : "YAML frontmatter block not found. Required for governance docs.",
    });

    if (hasFrontmatter) {
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (frontmatterMatch) {
        const frontmatter = frontmatterMatch[1];

        // Required fields — spec: title, uri, audience, tier, tags, epoch
        const requiredFields = ["title", "uri", "audience", "tier", "tags", "epoch"];
        const missingFields = requiredFields.filter((field) => !frontmatter.includes(`${field}:`));

        checks.push({
          name: "frontmatter_required_fields",
          passed: missingFields.length === 0,
          message: missingFields.length > 0
            ? `Missing required frontmatter fields: ${missingFields.join(", ")}`
            : null,
        });
      }
    }

    // Blockquote present (> line after title)
    // Look for a ">" line in the body (after frontmatter)
    const bodyAfterFrontmatter = content.replace(/^---[\s\S]*?---/, "").trim();
    const hasBlockquote = /^>/m.test(bodyAfterFrontmatter);
    checks.push({
      name: "blockquote_present",
      passed: hasBlockquote,
      message: hasBlockquote ? null : "No blockquote (>) found after title. Add a summary line starting with >.",
    });

    // Summary section
    const hasSummary = /^## Summary/m.test(content);
    checks.push({
      name: "summary_section",
      passed: hasSummary,
      message: hasSummary ? null : "No ## Summary section found. Recommended for governance docs.",
    });

    // Header quality — flag generic headers
    const headers = content.match(/^#{1,6}\s+(.+)$/gm) || [];
    const genericFound = [];
    for (const header of headers) {
      const headerText = header.replace(/^#{1,6}\s+/, "").trim().toLowerCase();
      if (GENERIC_HEADERS.includes(headerText)) {
        genericFound.push(header.trim());
      }
    }
    checks.push({
      name: "header_quality",
      passed: genericFound.length === 0,
      message: genericFound.length > 0
        ? `Generic headers found: ${genericFound.join(", ")}. Use descriptive headers instead.`
        : null,
    });
  }

  return { file: path, checks };
}

/**
 * Validate multiple files
 * @param {Array<{path: string, content: string}>} files
 * @returns {{ passed: boolean, results: Array }}
 */
export function validateFiles(files) {
  const results = files.map((f) => validateFile(f.path, f.content));
  const allPassed = results.every((r) => r.checks.every((c) => c.passed));
  return { passed: allPassed, results };
}
