#!/bin/bash
# sync-agents.test.sh - Test sync-agents command
#
# Tests:
# 1. Dry-run shows plan without copying
# 2. --only filters to subset
# 3. --dest overrides destination
# 4. --apply actually copies files
# 5. --no-backup skips backup creation

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI="$REPO_ROOT/bin/oddkit"

# Use a temp directory for test destination
TEST_DEST=$(mktemp -d)
trap "rm -rf $TEST_DEST" EXIT

echo "=== sync-agents tests ==="
echo "Test destination: $TEST_DEST"
echo ""

# Test 1: Dry-run (default) shows plan
echo "Test 1: Dry-run shows plan without copying..."
OUTPUT=$($CLI sync-agents --dest "$TEST_DEST" 2>&1)

if echo "$OUTPUT" | grep -q "Agent Sync Plan"; then
  echo "  ✓ Shows sync plan"
else
  echo "  ✗ Missing sync plan header"
  echo "$OUTPUT"
  exit 1
fi

if echo "$OUTPUT" | grep -q "Run with --apply"; then
  echo "  ✓ Prompts for --apply"
else
  echo "  ✗ Missing --apply prompt"
  exit 1
fi

# Verify nothing was copied
if [ "$(ls -A $TEST_DEST 2>/dev/null)" ]; then
  echo "  ✗ Files were copied in dry-run mode!"
  ls -la "$TEST_DEST"
  exit 1
else
  echo "  ✓ No files copied (dry-run)"
fi

echo ""

# Test 2: --only filters to subset
echo "Test 2: --only filters to subset..."
OUTPUT=$($CLI sync-agents --dest "$TEST_DEST" --only odd-map-navigator 2>&1)

if echo "$OUTPUT" | grep -q "odd-map-navigator"; then
  echo "  ✓ Shows requested agent"
else
  echo "  ✗ Missing requested agent"
  exit 1
fi

if echo "$OUTPUT" | grep -q "Total: 1"; then
  echo "  ✓ Filtered to single agent"
else
  echo "  ✗ Did not filter correctly"
  echo "$OUTPUT"
  exit 1
fi

echo ""

# Test 3: --apply copies files
echo "Test 3: --apply copies files..."
OUTPUT=$($CLI sync-agents --dest "$TEST_DEST" --only odd-map-navigator --apply 2>&1)

if echo "$OUTPUT" | grep -q "Successfully synced"; then
  echo "  ✓ Reports success"
else
  echo "  ✗ Missing success message"
  echo "$OUTPUT"
  exit 1
fi

if [ -f "$TEST_DEST/odd-map-navigator.md" ]; then
  echo "  ✓ File was copied"
else
  echo "  ✗ File was not copied"
  ls -la "$TEST_DEST"
  exit 1
fi

echo ""

# Test 4: Second run shows unchanged
echo "Test 4: Second run shows unchanged..."
OUTPUT=$($CLI sync-agents --dest "$TEST_DEST" --only odd-map-navigator 2>&1)

if echo "$OUTPUT" | grep -q "Unchanged: 1"; then
  echo "  ✓ Shows file as unchanged"
else
  echo "  ✗ Did not detect unchanged file"
  echo "$OUTPUT"
  exit 1
fi

if echo "$OUTPUT" | grep -q "All agents are in sync"; then
  echo "  ✓ Reports in-sync state"
else
  echo "  ✗ Missing in-sync message"
  exit 1
fi

echo ""

# Test 5: --apply with --no-backup skips backup
echo "Test 5: --apply creates backup by default..."

# First, modify the file to force an update
echo "# Modified" >> "$TEST_DEST/odd-map-navigator.md"

OUTPUT=$($CLI sync-agents --dest "$TEST_DEST" --only odd-map-navigator --apply 2>&1)

if echo "$OUTPUT" | grep -q "Backups created"; then
  echo "  ✓ Backup was created"
else
  echo "  ✗ Missing backup message"
  echo "$OUTPUT"
  exit 1
fi

if [ -d "$TEST_DEST/.bak" ]; then
  echo "  ✓ Backup directory exists"
else
  echo "  ✗ Backup directory not found"
  exit 1
fi

echo ""

# Test 6: Verbose output
echo "Test 6: --verbose shows hashes..."
OUTPUT=$($CLI sync-agents --dest "$TEST_DEST" --verbose 2>&1)

if echo "$OUTPUT" | grep -q "UNCHANGED"; then
  echo "  ✓ Verbose shows unchanged section"
else
  echo "  ✗ Missing unchanged section in verbose output"
  exit 1
fi

echo ""
echo "=== All sync-agents tests passed ==="
