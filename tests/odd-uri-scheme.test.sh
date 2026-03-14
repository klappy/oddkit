#!/usr/bin/env bash
set -euo pipefail

# Regression test: odd:// URI scheme must be parseable and resolvable
# Guards against Epoch 4 Blocker 2 re-breaking
#
# This test verifies:
# 1. normalizeRef accepts odd:// URIs
# 2. normalizeRef rejects path traversal in odd:// URIs
# 3. getDocByUri resolves odd:// URIs to correct paths
# 4. getDocByUri rejects path traversal attempts

echo "odd:// URI scheme regression test"
echo "=================================="

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE_DIR=$(mktemp -d)
trap "rm -rf $FIXTURE_DIR" EXIT

echo "Creating fixture at $FIXTURE_DIR"

# Create fixture with odd:// resolvable doc
mkdir -p "$FIXTURE_DIR/odd/contract"
cat > "$FIXTURE_DIR/odd/contract/epistemic-contract.md" << 'EOF'
---
uri: odd://contract/epistemic-contract
title: "Epistemic Contract"
---
# Epistemic Contract
Test content for regression test.
EOF

# Create a "secret" doc to test traversal prevention
mkdir -p "$FIXTURE_DIR/canon/secrets"
cat > "$FIXTURE_DIR/canon/secrets/password.md" << 'EOF'
---
title: "Secret Password"
---
# Secret Password
This should NOT be accessible via odd:// traversal.
EOF

# Test 1: normalizeRef accepts odd://
echo ""
echo "Test 1: normalizeRef accepts odd://"
RESULT1=$(node --input-type=module -e "
import { normalizeRef } from 'file://$PROJECT_ROOT/src/utils/normalizeRef.js';
console.log(normalizeRef('odd://contract/epistemic-contract'));
" 2>&1)

if [ "$RESULT1" = "odd://contract/epistemic-contract" ]; then
  echo "PASS: normalizeRef returns odd://contract/epistemic-contract"
else
  echo "FAIL: normalizeRef returned: $RESULT1"
  exit 1
fi

# Test 2: normalizeRef rejects path traversal
echo ""
echo "Test 2: normalizeRef rejects odd:// path traversal"
RESULT2=$(node --input-type=module -e "
import { normalizeRef } from 'file://$PROJECT_ROOT/src/utils/normalizeRef.js';
try {
  normalizeRef('odd://../canon/secrets/password');
  console.log('UNEXPECTED_PASS');
} catch (e) {
  if (e.message.includes('traversal')) {
    console.log('EXPECTED_ERROR');
  } else {
    console.log('WRONG_ERROR: ' + e.message);
  }
}
" 2>&1)

if [ "$RESULT2" = "EXPECTED_ERROR" ]; then
  echo "PASS: normalizeRef rejects traversal"
else
  echo "FAIL: normalizeRef traversal check: $RESULT2"
  exit 1
fi

# Test 3: getDocByUri resolves odd:// correctly
echo ""
echo "Test 3: getDocByUri resolves odd:// URIs"
RESULT3=$(node --input-type=module -e "
import { getDocByUri } from 'file://$PROJECT_ROOT/src/policy/docFetch.js';
const doc = await getDocByUri('odd://contract/epistemic-contract', { baseline: '$FIXTURE_DIR' });
if (doc?.content?.includes('Test content for regression test')) {
  console.log('PASS');
} else if (doc?.error) {
  console.log('ERROR: ' + JSON.stringify(doc.error));
} else {
  console.log('FAIL: content not found');
}
" 2>&1)

if [ "$RESULT3" = "PASS" ]; then
  echo "PASS: getDocByUri resolves odd:// to correct content"
else
  echo "FAIL: getDocByUri resolution: $RESULT3"
  exit 1
fi

# Test 4: getDocByUri rejects path traversal
echo ""
echo "Test 4: getDocByUri rejects odd:// path traversal"
RESULT4=$(node --input-type=module -e "
import { getDocByUri } from 'file://$PROJECT_ROOT/src/policy/docFetch.js';
try {
  await getDocByUri('odd://../canon/secrets/password', { baseline: '$FIXTURE_DIR' });
  console.log('UNEXPECTED_PASS');
} catch (e) {
  if (e.message.includes('traversal')) {
    console.log('EXPECTED_ERROR');
  } else {
    console.log('WRONG_ERROR: ' + e.message);
  }
}
" 2>&1)

if [ "$RESULT4" = "EXPECTED_ERROR" ]; then
  echo "PASS: getDocByUri rejects traversal"
else
  echo "FAIL: getDocByUri traversal check: $RESULT4"
  exit 1
fi

# Test 5: klappy:// traversal is also rejected
echo ""
echo "Test 5: klappy:// path traversal rejected"
RESULT5=$(node --input-type=module -e "
import { getDocByUri } from 'file://$PROJECT_ROOT/src/policy/docFetch.js';
try {
  await getDocByUri('klappy://../../../etc/passwd', { baseline: '$FIXTURE_DIR' });
  console.log('UNEXPECTED_PASS');
} catch (e) {
  if (e.message.includes('traversal')) {
    console.log('EXPECTED_ERROR');
  } else {
    console.log('WRONG_ERROR: ' + e.message);
  }
}
" 2>&1)

if [ "$RESULT5" = "EXPECTED_ERROR" ]; then
  echo "PASS: klappy:// rejects traversal"
else
  echo "FAIL: klappy:// traversal check: $RESULT5"
  exit 1
fi

# ──────────────────────────────────────────────────────────────────────────────
# kb:// URI scheme tests
# ──────────────────────────────────────────────────────────────────────────────

# Create fixture with kb:// resolvable doc
mkdir -p "$FIXTURE_DIR/sources"
cat > "$FIXTURE_DIR/sources/stringer-widening-the-table.surface.md" << 'EOF'
---
uri: kb://sources/stringer-widening-the-table
title: "Stringer: Widening the Table"
---
# Stringer: Widening the Table
Test content for kb:// URI resolution.
EOF

cat > "$FIXTURE_DIR/sources/example-topic.md" << 'EOF'
---
uri: kb://sources/example-topic
title: "Example Topic"
---
# Example Topic
Simple kb:// document.
EOF

# Test 6: getDocByUri resolves kb:// URIs
echo ""
echo "Test 6: getDocByUri resolves kb:// URIs"
RESULT6=$(node --input-type=module -e "
import { getDocByUri } from 'file://$PROJECT_ROOT/src/policy/docFetch.js';
const doc = await getDocByUri('kb://sources/example-topic', { baseline: '$FIXTURE_DIR' });
if (doc?.content?.includes('Simple kb:// document')) {
  console.log('PASS');
} else if (doc?.error) {
  console.log('ERROR: ' + JSON.stringify(doc.error));
} else {
  console.log('FAIL: content not found');
}
" 2>&1)

if [ "$RESULT6" = "PASS" ]; then
  echo "PASS: getDocByUri resolves kb:// to correct content"
else
  echo "FAIL: getDocByUri kb:// resolution: $RESULT6"
  exit 1
fi

# Test 7: getDocByUri resolves kb:// URIs with compound suffixes (.surface.md)
echo ""
echo "Test 7: getDocByUri resolves kb:// with .surface.md suffix"
RESULT7=$(node --input-type=module -e "
import { getDocByUri } from 'file://$PROJECT_ROOT/src/policy/docFetch.js';
const doc = await getDocByUri('kb://sources/stringer-widening-the-table', { baseline: '$FIXTURE_DIR' });
if (doc?.content?.includes('Test content for kb:// URI resolution')) {
  console.log('PASS');
} else if (doc?.error) {
  console.log('ERROR: ' + JSON.stringify(doc.error));
} else {
  console.log('FAIL: content not found');
}
" 2>&1)

if [ "$RESULT7" = "PASS" ]; then
  echo "PASS: getDocByUri resolves kb:// with .surface.md suffix"
else
  echo "FAIL: getDocByUri kb:// .surface.md resolution: $RESULT7"
  exit 1
fi

# Test 8: kb:// path traversal rejected
echo ""
echo "Test 8: kb:// path traversal rejected"
RESULT8=$(node --input-type=module -e "
import { getDocByUri } from 'file://$PROJECT_ROOT/src/policy/docFetch.js';
try {
  await getDocByUri('kb://../../../etc/passwd', { baseline: '$FIXTURE_DIR' });
  console.log('UNEXPECTED_PASS');
} catch (e) {
  if (e.message.includes('traversal')) {
    console.log('EXPECTED_ERROR');
  } else {
    console.log('WRONG_ERROR: ' + e.message);
  }
}
" 2>&1)

if [ "$RESULT8" = "EXPECTED_ERROR" ]; then
  echo "PASS: kb:// rejects traversal"
else
  echo "FAIL: kb:// traversal check: $RESULT8"
  exit 1
fi

echo ""
echo "=================================="
echo "All URI scheme tests passed!"
