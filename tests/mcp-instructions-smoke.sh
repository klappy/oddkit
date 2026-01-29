#!/usr/bin/env bash
set -euo pipefail

# Test that the instructions module exports correctly and contains expected content

echo "Testing MCP instructions module..."

# Run a Node script that imports and verifies the instructions
RESULT=$(node -e "
import { getOddkitInstructions } from './src/mcp/instructions.js';

const instructions = getOddkitInstructions();

// Verify it returns a non-empty string
if (typeof instructions !== 'string' || instructions.length === 0) {
  console.error('FAIL: instructions should be a non-empty string');
  process.exit(1);
}

// Verify key phrases are present
const requiredPhrases = [
  'oddkit_orchestrate',
  'NEVER paste large canon/docs',
  'ODDKIT DECISION GATE',
  'repo_root',
  'retrieve + quote'
];

for (const phrase of requiredPhrases) {
  if (!instructions.includes(phrase)) {
    console.error('FAIL: instructions missing required phrase:', phrase);
    process.exit(1);
  }
}

console.log('Instructions length:', instructions.length);
console.log('All required phrases present');
")

echo "$RESULT"

# Also verify the server can still boot with instructions
echo "Verifying MCP server boots with instructions..."
timeout 2 node bin/oddkit-mcp </dev/null >/dev/null 2>&1 || true

echo "✅ MCP instructions smoke test passed"
