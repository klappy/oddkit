/**
 * Governance validation for oddkit_write
 *
 * Validates content against ODD/Canon/Docs standards before writing.
 * Validation is informational - does not block writes.
 */

/**
 * Validate a file's content against governance constraints
 * @param {string} path - File path
 * @param {string} content - File content
 * @returns {Object} Validation results
 */
export function validateFile(path, content) {
  const checks = [];
  
  // Check if file targets canon/, odd/, or docs/
  const isGoverned = path.startsWith("canon/") || path.startsWith("odd/") || path.startsWith("docs/");
  
  if (isGoverned) {
    // Check for frontmatter
    const hasFrontmatter = content.trim().startsWith("---");
    checks.push({
      name: "frontmatter_present",
      passed: hasFrontmatter,
      message: hasFrontmatter ? null : "YAML frontmatter block not found. Recommended for governance docs.",
    });
    
    if (hasFrontmatter) {
      // Check for required frontmatter fields
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (frontmatterMatch) {
        const frontmatter = frontmatterMatch[1];
        const requiredFields = ["title", "uri"];
        const missingFields = requiredFields.filter(field => !frontmatter.includes(`${field}:`));
        
        checks.push({
          name: "frontmatter_required_fields",
          passed: missingFields.length === 0,
          message: missingFields.length > 0 ? `Missing required frontmatter fields: ${missingFields.join(", ")}` : null,
        });
        
        // Check for blockquote (summary line)
        const hasBlockquote = content.includes("> ");
        checks.push({
          name: "blockquote_present",
          passed: hasBlockquote,
          message: hasBlockquote ? null : "No blockquote (>) found after title. Consider adding a summary line.",
        });
        
        // Check for Summary section
        const hasSummary = content.includes("## Summary");
        checks.push({
          name: "summary_section",
          passed: hasSummary,
          message: hasSummary ? null : "No ## Summary section found. Recommended for decision docs.",
        });
      }
    }
  }
  
  // Check for UTF-8 validity (basic check)
  try {
    Buffer.from(content, "utf-8");
    checks.push({
      name: "utf8_valid",
      passed: true,
    });
  } catch {
    checks.push({
      name: "utf8_valid",
      passed: false,
      message: "Content is not valid UTF-8",
    });
  }
  
  // Check path is reasonable
  const hasTraversal = path.includes("..") || path.includes("~");
  checks.push({
    name: "path_safe",
    passed: !hasTraversal,
    message: hasTraversal ? "Path contains traversal sequences (.. or ~)" : null,
  });
  
  return {
    file: path,
    checks,
  };
}

/**
 * Validate multiple files
 * @param {Array} files - Array of {path, content} objects
 * @returns {Object} Combined validation results
 */
export function validateFiles(files) {
  const results = files.map(f => validateFile(f.path, f.content));
  
  const allPassed = results.every(r => r.checks.every(c => c.passed));
  
  return {
    passed: allPassed,
    results,
  };
}
