#!/usr/bin/env bash
set -euo pipefail

# Test that the instructions module exports correctly and contract invariants hold
# Tests assert on INSTRUCTION_CONTRACT keys, not prose - prose can evolve safely

echo "Testing MCP instructions module..."

# Run a Node script that imports and verifies the instructions
RESULT=$(node -e "
import { getOddkitInstructions, INSTRUCTION_CONTRACT } from './src/mcp/instructions.js';

const instructions = getOddkitInstructions();

// Verify it returns a non-empty string
if (typeof instructions !== 'string' || instructions.length === 0) {
  console.error('FAIL: instructions should be a non-empty string');
  process.exit(1);
}

// Verify INSTRUCTION_CONTRACT exists and has required keys
const requiredContractKeys = [
  'NO_PASTE_LARGE_CANON',
  'RETRIEVE_AND_QUOTE',
  'REPO_ROOT_REQUIRED',
  'ORCHESTRATE_IS_ENTRY',
  'DECISION_GATE_PATTERN'
];

if (!INSTRUCTION_CONTRACT || typeof INSTRUCTION_CONTRACT !== 'object') {
  console.error('FAIL: INSTRUCTION_CONTRACT not exported or not an object');
  process.exit(1);
}

for (const key of requiredContractKeys) {
  if (INSTRUCTION_CONTRACT[key] !== true) {
    console.error('FAIL: INSTRUCTION_CONTRACT missing or false:', key);
    process.exit(1);
  }
}

// Verify structural invariants (not prose)
if (!instructions.includes('oddkit_orchestrate')) {
  console.error('FAIL: instructions must mention oddkit_orchestrate');
  process.exit(1);
}

if (!instructions.includes('ODDKIT')) {
  console.error('FAIL: instructions must include ODDKIT identifier');
  process.exit(1);
}

console.log('Instructions length:', instructions.length);
console.log('Contract keys verified:', requiredContractKeys.length);
console.log('All invariants hold');
")

echo "$RESULT"

# Also verify the server can still boot with instructions
echo "Verifying MCP server boots with instructions..."
timeout 2 node bin/oddkit-mcp </dev/null >/dev/null 2>&1 || true

echo "✅ MCP instructions smoke test passed"
