#!/usr/bin/env bash
set -euo pipefail

# Antifragile orchestrator regression tests
# These verify the orchestrator never returns NO_ACTION and handles messy input gracefully

echo "Antifragile orchestrator regression tests"
echo "=========================================="

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Helper function to test detectAction
test_action() {
  local message="$1"
  local expected_action="$2"
  local test_name="$3"

  local result=$(node -e "
    import('file://$PROJECT_ROOT/src/mcp/orchestrate.js').then((mod) => {
      const { action, reason } = mod.detectAction('$message');
      console.log(JSON.stringify({ action, reason }));
    }).catch(err => {
      console.log(JSON.stringify({ error: err.message }));
    });
  " 2>&1)

  local actual_action=$(echo "$result" | grep -o '"action":"[^"]*"' | cut -d'"' -f4)

  if [ "$actual_action" = "$expected_action" ]; then
    echo "PASS: $test_name"
    echo "      Input: '$message' → $actual_action"
  else
    echo "FAIL: $test_name"
    echo "      Input: '$message'"
    echo "      Expected: $expected_action"
    echo "      Got: $actual_action"
    echo "      Full result: $result"
    exit 1
  fi
}

echo ""
echo "Test 1: Question with 'what is' → librarian"
test_action "what is the definition of done?" "librarian" "what is question"

echo ""
echo "Test 2: Phrase without question mark → librarian"
test_action "definition of done" "librarian" "phrase without ?"

echo ""
echo "Test 3: Strong completion claim → validate"
test_action "done with feature X" "validate" "done with [thing]"

echo ""
echo "Test 4: PR reference → validate"
test_action "shipped feature X, PR #42" "validate" "PR reference"

echo ""
echo "Test 5: Explicit explain → explain"
test_action "explain last" "explain" "explain last"

echo ""
echo "Test 6: Angry vague input → librarian (NOT no_action)"
test_action "THIS SUCKS" "librarian" "angry fallback"

echo ""
echo "Test 7: Just 'done' alone → librarian (NOT validate)"
test_action "done" "librarian" "done alone"

echo ""
echo "Test 8: Help request → librarian"
test_action "help" "librarian" "help request"

echo ""
echo "Test 9: Empty message → librarian"
test_action "" "librarian" "empty message"

echo ""
echo "Test 10: I finished statement → validate"
test_action "I finished the auth module" "validate" "I finished"

echo ""
echo "Test 11: Merged to main → validate"
test_action "merged to main" "validate" "merged to main"

echo ""
echo "Test 12: Random statement → librarian"
test_action "the sky is blue" "librarian" "random statement"

echo ""
echo "Test 13: Why question → explain"
test_action "why did you do that?" "explain" "why did you"

echo ""
echo "Test 14: What happened → explain"
test_action "what happened" "explain" "what happened"

echo ""
echo "=========================================="
echo "All antifragile tests passed!"
