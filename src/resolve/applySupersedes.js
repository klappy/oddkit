/**
 * Apply supersedes resolution: local docs can override baseline docs
 *
 * A local doc overrides a baseline doc if:
 * - local doc has `supersedes: "klappy://..."` matching baseline's uri
 *
 * Returns { filtered, suppressed }
 */
export function applySupersedes(docs) {
  // Collect all supersedes declarations from local docs
  const supersedesMap = new Map(); // uri -> local doc path

  for (const doc of docs) {
    if (doc.origin === "local" && doc.supersedes) {
      const supersededUris = Array.isArray(doc.supersedes) ? doc.supersedes : [doc.supersedes];

      for (const uri of supersededUris) {
        supersedesMap.set(uri, doc.path);
      }
    }
  }

  // Filter out baseline docs whose uri is superseded
  const filtered = [];
  const suppressed = {};

  for (const doc of docs) {
    if (doc.origin === "baseline" && doc.uri && supersedesMap.has(doc.uri)) {
      // This baseline doc is superseded
      suppressed[doc.uri] = supersedesMap.get(doc.uri);
    } else {
      filtered.push(doc);
    }
  }

  return { filtered, suppressed };
}
