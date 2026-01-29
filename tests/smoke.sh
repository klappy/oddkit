#!/bin/bash

# Smoke test for oddkit CLI
# Run from oddkit root: npm run test:smoke
# Works standalone - uses default baseline (klappy.dev from GitHub)

set -e

echo "oddkit smoke test"
echo "=================="

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

# Create a minimal test repo with one doc
mkdir -p "$TEMP_DIR/docs"
cat > "$TEMP_DIR/docs/test-doc.md" << 'HEREDOC'
---
title: Test Document
intent: operational
evidence: weak
---

# Test Document

This is a test document for smoke testing oddkit.

## Definition of Done

A task is done when all tests pass.

## Epistemic Hygiene

Always verify claims with evidence.
HEREDOC

# Test 1: Index command (uses default baseline from GitHub)
echo ""
echo "Test 1: Index command"
RESULT=$(node "$PROJECT_ROOT/bin/oddkit" index --repo "$TEMP_DIR" 2>&1) || true
echo "$RESULT" | head -20

if echo "$RESULT" | grep -q '"success": true'; then
  echo "PASS - Index: returned success"
else
  echo "FAIL - Index: no success in output"
  echo "Full output: $RESULT"
  exit 1
fi

# Test 2: Librarian query
echo ""
echo "Test 2: Librarian query"
RESULT=$(node "$PROJECT_ROOT/bin/oddkit" librarian --query "What is epistemic hygiene?" --repo "$TEMP_DIR" 2>&1) || true
echo "$RESULT" | head -30

if echo "$RESULT" | grep -q '"status"'; then
  echo "PASS - Librarian: returned status"
else
  echo "FAIL - Librarian: no status in output"
  echo "Full output: $RESULT"
  exit 1
fi

# Test 3: Validate command
echo ""
echo "Test 3: Validate command"
RESULT=$(node "$PROJECT_ROOT/bin/oddkit" validate --message "Done with the UI update. Here is a screenshot: ui.png" --repo "$TEMP_DIR" 2>&1) || true
echo "$RESULT" | head -20

if echo "$RESULT" | grep -q '"verdict"'; then
  echo "PASS - Validate: returned verdict"
else
  echo "FAIL - Validate: no verdict in output"
  echo "Full output: $RESULT"
  exit 1
fi

# Test 4: Explain command
echo ""
echo "Test 4: Explain last result"
RESULT=$(node "$PROJECT_ROOT/bin/oddkit" explain --last 2>&1) || true
echo "$RESULT" | head -25

if echo "$RESULT" | grep -q "Result"; then
  echo "PASS - Explain: rendered Result section"
else
  echo "FAIL - Explain: no Result section in output"
  echo "Full output: $RESULT"
  exit 1
fi

# Test 5: Check last.json exists
echo ""
echo "Test 5: Check last.json exists"
if [ -f ~/.oddkit/last.json ]; then
  echo "PASS - last.json: EXISTS"
else
  echo "FAIL - last.json: MISSING"
  exit 1
fi

# Test 6: Verify baseline source in debug output
echo ""
echo "Test 6: Verify baseline resolution"
RESULT=$(node "$PROJECT_ROOT/bin/oddkit" librarian --query "What is done?" --repo "$TEMP_DIR" 2>&1) || true

if echo "$RESULT" | grep -q '"baseline_source"'; then
  echo "PASS - Baseline source tracked in debug output"
else
  echo "FAIL - No baseline_source in debug output"
  exit 1
fi

echo ""
echo "=================="
echo "All smoke tests passed!"
