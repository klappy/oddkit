const ALLOWED_SCHEMES = ["klappy", "oddkit"];

/**
 * Normalize a ref strictly (shape only), with explicit scheme allowlist.
 * - requires scheme://path (non-empty path)
 * - lowercases scheme
 * - strips .md only
 * - collapses repeated slashes in the path segment
 * - removes trailing slash
 */
export function normalizeRef(ref) {
  if (typeof ref !== "string") {
    throw new Error(`Ref must be a string, got: ${typeof ref}`);
  }

  const protocolMatch = ref.match(/^([a-zA-Z]+):\/\/(.+)$/);
  if (!protocolMatch) {
    throw new Error(
      `Ref "${ref}" invalid. Must be scheme://path where scheme is klappy or oddkit. ` +
        `Examples: klappy://canon/foo, oddkit://tools/bar.json`,
    );
  }

  const scheme = protocolMatch[1].toLowerCase();
  if (!ALLOWED_SCHEMES.includes(scheme)) {
    throw new Error(
      `Ref "${ref}" has unknown scheme "${scheme}". Allowed: ${ALLOWED_SCHEMES.join(", ")}`,
    );
  }

  let path = protocolMatch[2];

  path = path.replace(/\.md$/, "");
  path = path.replace(/\/+/g, "/");
  path = path.replace(/\/$/, "");

  return `${scheme}://${path}`;
}

export const __internal = { ALLOWED_SCHEMES };
