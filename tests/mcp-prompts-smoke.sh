#!/usr/bin/env bash
set -euo pipefail

# Test MCP prompts functionality
# Tests the prompts module directly via Node.js

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

echo "Testing MCP prompts..."

# Test prompts module directly
node -e "
import { listPrompts, getPrompt } from '$ROOT_DIR/src/mcp/prompts.js';

// Test listPrompts
const prompts = listPrompts();
console.log('Listed prompts:', prompts.map(p => p.name).join(', '));

if (prompts.length !== 2) {
  console.error('❌ Expected 2 prompts, got', prompts.length);
  process.exit(1);
}

const hasCompass = prompts.some(p => p.name === 'oddkit_compass');
const hasCompassPrd = prompts.some(p => p.name === 'oddkit_compass_prd');

if (!hasCompass || !hasCompassPrd) {
  console.error('❌ Missing expected prompts');
  process.exit(1);
}
console.log('✅ listPrompts returns both compass prompts');

// Test getPrompt for oddkit_compass
const compass = getPrompt('oddkit_compass');
if (!compass || !compass.messages || compass.messages.length === 0) {
  console.error('❌ oddkit_compass missing messages');
  process.exit(1);
}
if (!compass.messages[0].content.text.includes('oddkit_orchestrate')) {
  console.error('❌ oddkit_compass missing expected content');
  process.exit(1);
}
console.log('✅ getPrompt returns oddkit_compass content');

// Test getPrompt for oddkit_compass_prd
const compassPrd = getPrompt('oddkit_compass_prd');
if (!compassPrd || !compassPrd.messages || compassPrd.messages.length === 0) {
  console.error('❌ oddkit_compass_prd missing messages');
  process.exit(1);
}
if (!compassPrd.messages[0].content.text.includes('PRD')) {
  console.error('❌ oddkit_compass_prd missing expected content');
  process.exit(1);
}
console.log('✅ getPrompt returns oddkit_compass_prd content');

// Test unknown prompt returns null
const unknown = getPrompt('nonexistent');
if (unknown !== null) {
  console.error('❌ getPrompt should return null for unknown prompt');
  process.exit(1);
}
console.log('✅ getPrompt returns null for unknown prompt');

console.log('');
console.log('✅ All MCP prompts tests passed');
"

echo ""
echo "✅ Prompts module tests complete"
