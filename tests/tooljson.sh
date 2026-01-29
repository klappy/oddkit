#!/bin/bash

# Tool-grade contract test for oddkit CLI
# Tests that tooljson output is machine-parseable and stderr is clean
#
# Run: npm run test:tooljson

set -e

echo "oddkit tooljson contract test"
echo "=============================="

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Create temp directory for test repo
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

echo ""
echo "Setting up test environment..."

# Create a minimal test repo
mkdir -p "$TEMP_DIR/docs"
cat > "$TEMP_DIR/docs/test.md" << 'HEREDOC'
---
title: Test Document
---

# Test Document

This is a test.
HEREDOC

# Helper function to check JSON validity
check_json() {
  local name="$1"
  local json="$2"
  
  # Check if it's valid JSON
  if ! echo "$json" | python3 -c "import sys, json; json.load(sys.stdin)" 2>/dev/null; then
    echo "FAIL - $name: Invalid JSON"
    echo "Output: $json"
    return 1
  fi
  
  # Check for required tooljson fields
  if ! echo "$json" | python3 -c "import sys, json; d=json.load(sys.stdin); assert 'tool' in d, 'missing tool'; assert 'schema_version' in d, 'missing schema_version'; assert 'ok' in d, 'missing ok'" 2>/dev/null; then
    echo "FAIL - $name: Missing required tooljson fields"
    echo "Output: $json"
    return 1
  fi
  
  echo "PASS - $name: Valid tooljson envelope"
  return 0
}

# Test 1: tool librarian outputs valid tooljson
echo ""
echo "Test 1: tool librarian outputs valid tooljson"
STDOUT=$(node "$PROJECT_ROOT/bin/oddkit" tool librarian -q "What is done?" -r "$TEMP_DIR" 2>/dev/null)
STDERR=$(node "$PROJECT_ROOT/bin/oddkit" tool librarian -q "What is done?" -r "$TEMP_DIR" 2>&1 >/dev/null || true)

check_json "tool librarian" "$STDOUT"

if [ -n "$STDERR" ]; then
  echo "WARN - tool librarian: stderr not empty (should be clean)"
  echo "stderr: $STDERR"
fi

# Test 2: tool validate outputs valid tooljson
echo ""
echo "Test 2: tool validate outputs valid tooljson"
STDOUT=$(node "$PROJECT_ROOT/bin/oddkit" tool validate -m "Done with task" -r "$TEMP_DIR" 2>/dev/null)

check_json "tool validate" "$STDOUT"

# Test 3: tool explain outputs valid tooljson
echo ""
echo "Test 3: tool explain outputs valid tooljson"
STDOUT=$(node "$PROJECT_ROOT/bin/oddkit" tool explain 2>/dev/null)

check_json "tool explain" "$STDOUT"

# Test 4: --format tooljson on regular commands
echo ""
echo "Test 4: --format tooljson on regular commands"
STDOUT=$(node "$PROJECT_ROOT/bin/oddkit" librarian -q "What is done?" -r "$TEMP_DIR" --format tooljson 2>/dev/null)

check_json "librarian --format tooljson" "$STDOUT"

# Test 5: Error outputs valid tooljson envelope with ok=false
echo ""
echo "Test 5: Error outputs valid tooljson (ok=false)"
STDOUT=$(node "$PROJECT_ROOT/bin/oddkit" tool librarian -r "$TEMP_DIR" 2>/dev/null || true)

if echo "$STDOUT" | python3 -c "import sys, json; d=json.load(sys.stdin); assert d['ok'] == False, 'ok should be false'" 2>/dev/null; then
  echo "PASS - Error case: tooljson with ok=false"
else
  echo "FAIL - Error case: Expected ok=false"
  echo "Output: $STDOUT"
  exit 1
fi

# Test 6: stdin support
echo ""
echo "Test 6: stdin support (@stdin)"
STDOUT=$(echo "What is epistemic hygiene?" | node "$PROJECT_ROOT/bin/oddkit" tool librarian -q @stdin -r "$TEMP_DIR" 2>/dev/null)

check_json "stdin support" "$STDOUT"

# Test 7: Verify schema_version is present
echo ""
echo "Test 7: schema_version field present"
STDOUT=$(node "$PROJECT_ROOT/bin/oddkit" tool librarian -q "test" -r "$TEMP_DIR" 2>/dev/null)
VERSION=$(echo "$STDOUT" | python3 -c "import sys, json; print(json.load(sys.stdin)['schema_version'])" 2>/dev/null)

if [ -n "$VERSION" ]; then
  echo "PASS - schema_version: $VERSION"
else
  echo "FAIL - schema_version missing"
  exit 1
fi

# Test 8: Exit code is 0 even for tooljson errors
echo ""
echo "Test 8: Exit code 0 for tooljson mode"
node "$PROJECT_ROOT/bin/oddkit" tool librarian -r "$TEMP_DIR" 2>/dev/null
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  echo "PASS - Exit code 0 for tooljson errors"
else
  echo "FAIL - Expected exit code 0, got $EXIT_CODE"
  exit 1
fi

echo ""
echo "=============================="
echo "All tooljson contract tests passed!"
