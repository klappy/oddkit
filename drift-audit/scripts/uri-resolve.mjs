// drift-audit/scripts/uri-resolve.mjs
import { getDocByUri } from "../../src/policy/docFetch.js";

const uri = process.argv[2];
if (!uri) {
  console.error("Usage: node uri-resolve.mjs <uri>");
  process.exit(1);
}

const result = await getDocByUri(uri);
console.log(
  JSON.stringify(
    {
      uri,
      hasContent: !!result?.content,
      error: result?.error || null,
    },
    null,
    2,
  ),
);
