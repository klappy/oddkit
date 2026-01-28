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

# Test 4: Explain command
echo ""
echo "Test 4: Explain last result"
RESULT=$(node bin/oddkit explain --last 2>&1)
echo "$RESULT" | head -25

if echo "$RESULT" | grep -q "Result"; then
  echo "✅ Explain: PASS (rendered Result section)"
else
  echo "❌ Explain: FAIL (no Result section in output)"
  exit 1
fi

# Test 5: Check last.json exists
echo ""
echo "Test 5: Check last.json exists"
if [ -f ~/.oddkit/last.json ]; then
  echo "✅ last.json: EXISTS"
else
  echo "❌ last.json: MISSING"
  exit 1
fi

echo ""
echo "===================="
echo "🎉 All smoke tests passed!"
