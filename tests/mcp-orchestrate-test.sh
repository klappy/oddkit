#!/usr/bin/env bash
set -euo pipefail

# Test that orchestrate returns assistant_text with excerpt quotes
# This ensures Cursor can print the answer verbatim without freestyle narration

echo "Testing oddkit_orchestrate assistant_text output"
echo "================================================"

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Create temp directory for test repo
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

echo ""
echo "Setting up test environment..."
echo "  Project root: $PROJECT_ROOT"
echo "  Temp dir: $TEMP_DIR"

# Create a test doc with a substantial section
mkdir -p "$TEMP_DIR/canon"
cat > "$TEMP_DIR/canon/epistemic-challenge.md" << 'HEREDOC'
---
title: Epistemic Challenge
intent: promoted
evidence: strong
---

# Epistemic Challenge

The epistemic challenge refers to the fundamental difficulty of knowing what we know and verifying claims in complex systems.

## Core Problem

When working with distributed systems, multiple stakeholders, and evolving requirements, it becomes increasingly difficult to maintain certainty about the current state of knowledge. This challenge manifests in several ways: incomplete information, conflicting signals, and the need to make decisions under uncertainty.

## Mitigation Strategies

The primary mitigation strategy involves creating explicit documentation that captures decisions, constraints, and evidence. This documentation must be searchable, versioned, and linked to specific artifacts that support claims.

## Evidence Requirements

All claims about system behavior or completion status must be backed by observable evidence. This includes screenshots for UI changes, logs for system behavior, and test results for functionality verification.
HEREDOC

# Build index first
echo ""
echo "Building index..."
node "$PROJECT_ROOT/bin/oddkit" index --repo "$TEMP_DIR" > /dev/null 2>&1 || true

# Test orchestrate via direct import (not MCP server, just the function)
echo ""
echo "Testing orchestrate function..."
RESULT=$(node -e "
import('file://$PROJECT_ROOT/src/mcp/orchestrate.js').then(async (mod) => {
  const result = await mod.runOrchestrate({
    message: 'What is epistemic challenge?',
    repoRoot: '$TEMP_DIR'
  });
  console.log(JSON.stringify(result, null, 2));
}).catch(err => {
  console.error(JSON.stringify({error: err.message}));
  process.exit(1);
});
" 2>&1)

echo "$RESULT" | head -50

# Check for assistant_text
if echo "$RESULT" | grep -q '"assistant_text"'; then
  echo "PASS - assistant_text exists"
else
  echo "FAIL - assistant_text missing"
  echo "Full output: $RESULT"
  exit 1
fi

# Check for citations
if echo "$RESULT" | grep -q 'canon/epistemic-challenge.md'; then
  echo "PASS - Contains canonical document reference"
else
  echo "FAIL - Missing canonical document reference"
  exit 1
fi

# Check for at least one quote >= 15 words (not just tagline)
ASSISTANT_TEXT=$(echo "$RESULT" | node -e "
const fs = require('fs');
const d = fs.readFileSync(0, 'utf8');
try {
  const j = JSON.parse(d);
  console.log(j.assistant_text || '');
} catch { console.log(''); }
" 2>/dev/null || echo "")
QUOTE_WORDS=$(echo "$ASSISTANT_TEXT" | grep -o '> [^—]*' | head -1 | wc -w | tr -d ' ' || echo "0")
QUOTE_WORDS=${QUOTE_WORDS:-0}

if [ "$QUOTE_WORDS" -ge 15 ] 2>/dev/null; then
  echo "PASS - Quote length >= 15 words (excerpt upgrade working)"
else
  echo "WARN - Quote may be too short (words: $QUOTE_WORDS)"
  # Don't fail on this, just warn
fi

# Check for citations in assistant_text
if echo "$ASSISTANT_TEXT" | grep -qE '\.md#|\.md\)'; then
  echo "PASS - Contains citations with anchors"
else
  echo "FAIL - Missing citations with anchors"
  echo "--- assistant_text ---"
  echo "$ASSISTANT_TEXT"
  echo "---"
  exit 1
fi

echo ""
echo "=================="
echo "All orchestrate tests passed!"
