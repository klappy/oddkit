// drift-audit/scripts/normalize-ref.mjs
import { normalizeRef, __internal } from "../../src/utils/normalizeRef.js";

const ref = process.argv[2];
console.log("Allowed schemes:", __internal.ALLOWED_SCHEMES);

if (ref) {
  try {
    const result = normalizeRef(ref);
    console.log("Result:", result);
  } catch (err) {
    console.log("Error:", err.message);
  }
}
