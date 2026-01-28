#!/bin/bash

# Smoke test for oddkit CLI
# Run from oddkit root

set -e

echo "🧪 oddkit smoke test"
echo "===================="

# Test 1: Index command
echo ""
echo "Test 1: Index command"
node bin/oddkit index --repo ../klappy.dev 2>&1 | head -20
if [ $? -eq 0 ]; then
  echo "✅ Index: PASS"
else
  echo "❌ Index: FAIL"
  exit 1
fi

# Test 2: Librarian query
echo ""
echo "Test 2: Librarian query"
RESULT=$(node bin/oddkit librarian --query "What is the definition of done?" --repo ../klappy.dev 2>&1)
echo "$RESULT" | head -30

if echo "$RESULT" | grep -q '"status"'; then
  echo "✅ Librarian: PASS (returned status)"
else
  echo "❌ Librarian: FAIL (no status in output)"
  exit 1
fi

# Test 3: Validate command
echo ""
echo "Test 3: Validate command"
RESULT=$(node bin/oddkit validate --message "Done with the UI update. Here's a screenshot: ui.png" 2>&1)
echo "$RESULT" | head -20

if echo "$RESULT" | grep -q '"verdict"'; then
  echo "✅ Validate: PASS (returned verdict)"
else
  echo "❌ Validate: FAIL (no verdict in output)"
  exit 1
fi

echo ""
echo "===================="
echo "🎉 All smoke tests passed!"
