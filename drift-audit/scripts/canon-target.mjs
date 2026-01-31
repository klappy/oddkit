// drift-audit/scripts/canon-target.mjs
import { resolveCanonTarget } from "../../src/policy/canonTarget.js";

const target = await resolveCanonTarget();
console.log(JSON.stringify(target, null, 2));
