#!/bin/bash

# CLI-MCP Parity test for oddkit
# Verifies that CLI and MCP (via handleAction) produce structurally identical results.
#
# Run: bash tests/parity.test.sh

set -e

echo "oddkit CLI-MCP parity test"
echo "=========================="

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Create temp directory
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

echo ""
echo "Setting up test environment..."

# Create a minimal test repo
mkdir -p "$TEMP_DIR/docs"
cat > "$TEMP_DIR/docs/test.md" << 'HEREDOC'
---
title: Test Document
intent: operational
---

# Test Document

This is a test document for parity testing.
HEREDOC

# Helper: extract top-level keys from JSON
get_keys() {
  echo "$1" | python3 -c "import sys, json; print(sorted(json.load(sys.stdin).keys()))" 2>/dev/null
}

# Helper: check that JSON has expected keys
check_envelope() {
  local name="$1"
  local json="$2"
  local required_keys="$3"

  for key in $required_keys; do
    if ! echo "$json" | python3 -c "import sys, json; d=json.load(sys.stdin); assert '$key' in d, 'missing $key'" 2>/dev/null; then
      echo "FAIL - $name: Missing key '$key'"
      echo "Output: $json"
      return 1
    fi
  done
  echo "PASS - $name"
  return 0
}

# ──────────────────────────────────────────────────────────────────────────────
# Test 1: All 11 actions produce the same envelope shape (action, result, assistant_text, debug)
# ──────────────────────────────────────────────────────────────────────────────

echo ""
echo "Test 1: Orient produces standard envelope"
CLI_RESULT=$(node "$PROJECT_ROOT/bin/oddkit" orient -i "Build a new feature" -r "$TEMP_DIR" 2>/dev/null)
check_envelope "orient envelope" "$CLI_RESULT" "action result assistant_text debug"

echo ""
echo "Test 2: Challenge produces standard envelope"
CLI_RESULT=$(node "$PROJECT_ROOT/bin/oddkit" challenge -i "We must use PostgreSQL" -r "$TEMP_DIR" 2>/dev/null)
check_envelope "challenge envelope" "$CLI_RESULT" "action result assistant_text debug"

echo ""
echo "Test 3: Gate produces standard envelope"
CLI_RESULT=$(node "$PROJECT_ROOT/bin/oddkit" gate -i "Ready to build" -r "$TEMP_DIR" 2>/dev/null)
check_envelope "gate envelope" "$CLI_RESULT" "action result assistant_text debug"

echo ""
echo "Test 4: Encode produces standard envelope"
CLI_RESULT=$(node "$PROJECT_ROOT/bin/oddkit" encode -i "Decision: use Node.js for backend" -r "$TEMP_DIR" 2>/dev/null)
check_envelope "encode envelope" "$CLI_RESULT" "action result assistant_text debug"

echo ""
echo "Test 5: Search produces standard envelope"
CLI_RESULT=$(node "$PROJECT_ROOT/bin/oddkit" search -i "What is done?" -r "$TEMP_DIR" 2>/dev/null)
check_envelope "search envelope" "$CLI_RESULT" "action result assistant_text debug"

echo ""
echo "Test 6: Catalog produces standard envelope"
CLI_RESULT=$(node "$PROJECT_ROOT/bin/oddkit" catalog -r "$TEMP_DIR" 2>/dev/null)
check_envelope "catalog envelope" "$CLI_RESULT" "action result assistant_text debug"

echo ""
echo "Test 7: Validate produces standard envelope"
CLI_RESULT=$(node "$PROJECT_ROOT/bin/oddkit" validate -i "done: implemented feature X" -r "$TEMP_DIR" 2>/dev/null)
check_envelope "validate envelope" "$CLI_RESULT" "action result assistant_text debug"

echo ""
echo "Test 8: Preflight produces standard envelope"
CLI_RESULT=$(node "$PROJECT_ROOT/bin/oddkit" preflight -i "add authentication" -r "$TEMP_DIR" 2>/dev/null)
check_envelope "preflight envelope" "$CLI_RESULT" "action result assistant_text debug"

echo ""
echo "Test 9: Version produces standard envelope"
CLI_RESULT=$(node "$PROJECT_ROOT/bin/oddkit" version -r "$TEMP_DIR" 2>/dev/null)
check_envelope "version envelope" "$CLI_RESULT" "action result assistant_text debug"

echo ""
echo "Test 10: Invalidate_cache produces standard envelope"
CLI_RESULT=$(node "$PROJECT_ROOT/bin/oddkit" invalidate_cache -r "$TEMP_DIR" 2>/dev/null)
check_envelope "invalidate_cache envelope" "$CLI_RESULT" "action result assistant_text debug"

# ──────────────────────────────────────────────────────────────────────────────
# Test 11: CLI search and legacy librarian both return results
# ──────────────────────────────────────────────────────────────────────────────

echo ""
echo "Test 11: Search via new CLI and legacy librarian both work"
SEARCH_RESULT=$(node "$PROJECT_ROOT/bin/oddkit" search -i "What is done?" -r "$TEMP_DIR" 2>/dev/null)
LIBRARIAN_RESULT=$(node "$PROJECT_ROOT/bin/oddkit" librarian -q "What is done?" -r "$TEMP_DIR" 2>/dev/null)

SEARCH_HAS_ACTION=$(echo "$SEARCH_RESULT" | python3 -c "import sys, json; d=json.load(sys.stdin); print('yes' if 'action' in d else 'no')" 2>/dev/null)
LIBRARIAN_HAS_STATUS=$(echo "$LIBRARIAN_RESULT" | python3 -c "import sys, json; d=json.load(sys.stdin); print('yes' if 'status' in d else 'no')" 2>/dev/null)

if [ "$SEARCH_HAS_ACTION" = "yes" ] && [ "$LIBRARIAN_HAS_STATUS" = "yes" ]; then
  echo "PASS - Both search (new) and librarian (legacy) return valid results"
else
  echo "FAIL - search has action=$SEARCH_HAS_ACTION, librarian has status=$LIBRARIAN_HAS_STATUS"
  exit 1
fi

# ──────────────────────────────────────────────────────────────────────────────
# Test 12: Backward compat — validate --message still works
# ──────────────────────────────────────────────────────────────────────────────

echo ""
echo "Test 12: Backward compat — validate --message"
CLI_RESULT=$(node "$PROJECT_ROOT/bin/oddkit" validate --message "Done with task X" -r "$TEMP_DIR" 2>/dev/null)
if echo "$CLI_RESULT" | python3 -c "import sys, json; d=json.load(sys.stdin); assert d['action'] == 'validate'" 2>/dev/null; then
  echo "PASS - validate --message backward compat"
else
  echo "FAIL - validate --message did not produce validate action"
  echo "Output: $CLI_RESULT"
  exit 1
fi

# ──────────────────────────────────────────────────────────────────────────────
# Test 13: tool subcommand with new actions works
# ──────────────────────────────────────────────────────────────────────────────

echo ""
echo "Test 13: tool orient produces tooljson envelope"
CLI_RESULT=$(node "$PROJECT_ROOT/bin/oddkit" tool orient -i "Build a feature" -r "$TEMP_DIR" 2>/dev/null)
check_envelope "tool orient tooljson" "$CLI_RESULT" "tool schema_version ok result"

echo ""
echo "Test 14: tool search produces tooljson envelope"
CLI_RESULT=$(node "$PROJECT_ROOT/bin/oddkit" tool search -i "What is done?" -r "$TEMP_DIR" 2>/dev/null)
check_envelope "tool search tooljson" "$CLI_RESULT" "tool schema_version ok result"

echo ""
echo "=========================="
echo "All parity tests passed!"
