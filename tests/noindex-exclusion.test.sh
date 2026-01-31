#!/usr/bin/env bash
set -euo pipefail

# Regression test: .noindex sentinel must exclude directory from indexing
# Guards against Epoch 4 Blocker 1 re-breaking
#
# This test verifies:
# 1. Files in directories with .noindex are excluded from index
# 2. excluded_by_noindex stat is populated
# 3. Normal docs (no .noindex ancestor) are still indexed

echo ".noindex exclusion regression test"
echo "==================================="

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE_DIR=$(mktemp -d)
trap "rm -rf $FIXTURE_DIR" EXIT

echo "Creating fixture at $FIXTURE_DIR"

# Create fixture with .noindex sentinel
mkdir -p "$FIXTURE_DIR/canon/apocrypha/fragments"

# The .noindex sentinel file
cat > "$FIXTURE_DIR/canon/apocrypha/.noindex" << 'EOF'
# This directory must not be indexed by tooling.
# See CHARTER.md for rationale.
EOF

# Files that should be excluded
cat > "$FIXTURE_DIR/canon/apocrypha/CHARTER.md" << 'EOF'
---
title: "Apocrypha Charter"
---
# Apocrypha Charter
This should NOT appear in index.
EOF

cat > "$FIXTURE_DIR/canon/apocrypha/fragments/secret.md" << 'EOF'
---
title: "Secret Fragment"
---
# Secret Fragment
This should NOT appear in index either (nested).
EOF

# Create a normal doc that SHOULD be indexed
mkdir -p "$FIXTURE_DIR/canon"
cat > "$FIXTURE_DIR/canon/normal-doc.md" << 'EOF'
---
title: "Normal Document"
---
# Normal Document
This SHOULD appear in index.
EOF

# Build index (disable baseline to isolate test)
echo ""
echo "Building index..."
ODDKIT_BASELINE_REF=invalid-to-disable node "$PROJECT_ROOT/bin/oddkit" index -r "$FIXTURE_DIR" >/dev/null 2>&1 || true

INDEX_PATH="$FIXTURE_DIR/.oddkit/index.json"

if [ ! -f "$INDEX_PATH" ]; then
  echo "FAIL: Index file not created"
  exit 1
fi

# Test 1: Check excluded_by_noindex stat
echo ""
echo "Test 1: excluded_by_noindex stat"
EXCLUDED=$(node -e "
const idx = require('$INDEX_PATH');
console.log(idx.stats?.excluded_by_noindex ?? 0);
")

if [ "$EXCLUDED" -ge 2 ]; then
  echo "PASS: excluded_by_noindex = $EXCLUDED (expected >= 2)"
else
  echo "FAIL: excluded_by_noindex = $EXCLUDED (expected >= 2)"
  exit 1
fi

# Test 2: Verify apocrypha docs NOT in index
echo ""
echo "Test 2: Apocrypha docs excluded"
APOCRYPHA_COUNT=$(node -e "
const idx = require('$INDEX_PATH');
const count = idx.documents.filter(d => d.path.includes('apocrypha')).length;
console.log(count);
")

if [ "$APOCRYPHA_COUNT" -eq 0 ]; then
  echo "PASS: 0 apocrypha docs in index"
else
  echo "FAIL: Found $APOCRYPHA_COUNT apocrypha docs in index (expected 0)"
  exit 1
fi

# Test 3: Verify normal doc IS in index
echo ""
echo "Test 3: Normal docs included"
NORMAL_COUNT=$(node -e "
const idx = require('$INDEX_PATH');
const count = idx.documents.filter(d => d.path.includes('normal-doc')).length;
console.log(count);
")

if [ "$NORMAL_COUNT" -ge 1 ]; then
  echo "PASS: normal-doc.md in index"
else
  echo "FAIL: normal-doc.md not in index (expected >= 1)"
  exit 1
fi

echo ""
echo "==================================="
echo "All .noindex regression tests passed!"
