#!/bin/bash

# Content-addressed caching verification test
#
# Verifies that oddkit's caching is keyed to commit SHA, not TTL:
# 1. No TTL-based expiration constants exist in the codebase
# 2. The cleanup_storage action exists (replaces invalidate_cache)
# 3. Debug output includes baseline_sha
# 4. Cache directories are SHA-keyed
# 5. BM25 index is SHA-keyed (not referential identity)

set -e

echo "Content-addressed caching verification test"
echo "============================================="

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

PASS=0
FAIL=0

pass() {
  echo "  PASS - $1"
  PASS=$((PASS + 1))
}

fail() {
  echo "  FAIL - $1"
  FAIL=$((FAIL + 1))
}

# ──────────────────────────────────────────────────────────────────────────────
# Test 1: No TTL constants in the Node.js caching code
# ──────────────────────────────────────────────────────────────────────────────

echo ""
echo "Test 1: No TTL-based expiration in Node.js caching layer"

# Check ensureBaselineRepo.js has no TTL-based expiration logic (comments explaining "no TTL" are fine)
if grep -v "NOT a TTL\|No TTL\|No staleness" "$PROJECT_ROOT/src/baseline/ensureBaselineRepo.js" | grep -q "expirationTtl\|setTimeout.*cache\|_TTL\s*="; then
  fail "ensureBaselineRepo.js still contains TTL-based expiration logic"
else
  pass "ensureBaselineRepo.js has no TTL-based expiration logic"
fi

# Check actions.js BM25 cache is SHA-keyed
if grep -q "cachedBM25Sha" "$PROJECT_ROOT/src/core/actions.js" 2>/dev/null; then
  pass "BM25 index cache is SHA-keyed (cachedBM25Sha)"
else
  fail "BM25 index cache is not SHA-keyed"
fi

# ──────────────────────────────────────────────────────────────────────────────
# Test 2: invalidate_cache is replaced with cleanup_storage
# ──────────────────────────────────────────────────────────────────────────────

echo ""
echo "Test 2: invalidate_cache renamed to cleanup_storage"

if grep -q '"cleanup_storage"' "$PROJECT_ROOT/src/core/tool-registry.js" 2>/dev/null; then
  pass "tool-registry.js defines cleanup_storage"
else
  fail "tool-registry.js missing cleanup_storage"
fi

if grep -q '"invalidate_cache"' "$PROJECT_ROOT/src/core/tool-registry.js" 2>/dev/null; then
  fail "tool-registry.js still contains invalidate_cache"
else
  pass "tool-registry.js no longer contains invalidate_cache"
fi

if grep -q 'case "cleanup_storage"' "$PROJECT_ROOT/src/core/actions.js" 2>/dev/null; then
  pass "actions.js handles cleanup_storage action"
else
  fail "actions.js missing cleanup_storage handler"
fi

# ──────────────────────────────────────────────────────────────────────────────
# Test 3: Debug output includes baseline_sha
# ──────────────────────────────────────────────────────────────────────────────

echo ""
echo "Test 3: Debug output includes baseline SHA"

if grep -q "baseline_sha" "$PROJECT_ROOT/src/core/actions.js" 2>/dev/null; then
  pass "actions.js includes baseline_sha in debug output"
else
  fail "actions.js missing baseline_sha in debug output"
fi

# ──────────────────────────────────────────────────────────────────────────────
# Test 4: Prompt cache is SHA-keyed
# ──────────────────────────────────────────────────────────────────────────────

echo ""
echo "Test 4: Prompt cache is SHA-keyed"

if grep -q "cachedPromptsSha" "$PROJECT_ROOT/src/mcp/prompts.js" 2>/dev/null; then
  pass "prompts.js uses SHA-keyed cache (cachedPromptsSha)"
else
  fail "prompts.js not SHA-keyed"
fi

# ──────────────────────────────────────────────────────────────────────────────
# Test 5: Baseline index is SHA-keyed
# ──────────────────────────────────────────────────────────────────────────────

echo ""
echo "Test 5: Baseline index save/load accepts commitSha parameter"

if grep -q "commitSha" "$PROJECT_ROOT/src/index/buildIndex.js" 2>/dev/null; then
  pass "buildIndex.js has commitSha parameter for SHA-keyed storage"
else
  fail "buildIndex.js missing commitSha parameter"
fi

# ──────────────────────────────────────────────────────────────────────────────
# Test 6: Session SHA resolution
# ──────────────────────────────────────────────────────────────────────────────

echo ""
echo "Test 6: Per-session SHA resolution cache"

if grep -q "sessionResolvedSha" "$PROJECT_ROOT/src/baseline/ensureBaselineRepo.js" 2>/dev/null; then
  pass "ensureBaselineRepo.js has per-session SHA resolution"
else
  fail "ensureBaselineRepo.js missing per-session SHA resolution"
fi

if grep -q "getSessionSha" "$PROJECT_ROOT/src/baseline/ensureBaselineRepo.js" 2>/dev/null; then
  pass "ensureBaselineRepo.js exports getSessionSha for observability"
else
  fail "ensureBaselineRepo.js missing getSessionSha export"
fi

# ──────────────────────────────────────────────────────────────────────────────
# Test 7: Workers use content-addressed caching
# ──────────────────────────────────────────────────────────────────────────────

echo ""
echo "Test 7: Workers use content-addressed caching"

if grep -q "INDEX_TTL\|FILE_TTL\|ZIP_TTL" "$PROJECT_ROOT/workers/src/zip-baseline-fetcher.ts" 2>/dev/null; then
  fail "zip-baseline-fetcher.ts still contains TTL constants"
else
  pass "zip-baseline-fetcher.ts has no TTL constants"
fi

if grep -q "expirationTtl" "$PROJECT_ROOT/workers/src/zip-baseline-fetcher.ts" 2>/dev/null; then
  fail "zip-baseline-fetcher.ts still uses expirationTtl"
else
  pass "zip-baseline-fetcher.ts has no expirationTtl usage"
fi

if grep -q "cleanup_storage" "$PROJECT_ROOT/workers/src/index.ts" 2>/dev/null; then
  pass "workers/index.ts uses cleanup_storage (not invalidate_cache)"
else
  fail "workers/index.ts missing cleanup_storage"
fi

# ──────────────────────────────────────────────────────────────────────────────
# Test 8: Functional test — cleanup_storage returns correct envelope
# ──────────────────────────────────────────────────────────────────────────────

echo ""
echo "Test 8: cleanup_storage action produces correct response"

mkdir -p "$TEMP_DIR/docs"
cat > "$TEMP_DIR/docs/test.md" << 'EOF'
---
title: Test
---
# Test
EOF

CLI_RESULT=$(node "$PROJECT_ROOT/bin/oddkit" cleanup_storage -r "$TEMP_DIR" 2>/dev/null) || true

if echo "$CLI_RESULT" | grep -q '"action"'; then
  pass "cleanup_storage returns action field"
else
  fail "cleanup_storage missing action field"
fi

if echo "$CLI_RESULT" | grep -q '"cleanup_storage"'; then
  pass "cleanup_storage action value is correct"
else
  fail "cleanup_storage action value wrong"
fi

if echo "$CLI_RESULT" | grep -q 'hygiene'; then
  pass "cleanup_storage message explains this is hygiene, not correctness"
else
  fail "cleanup_storage message doesn't explain hygiene purpose"
fi

if echo "$CLI_RESULT" | grep -q '"baseline_sha"'; then
  pass "cleanup_storage debug includes baseline_sha"
else
  fail "cleanup_storage debug missing baseline_sha"
fi

# ──────────────────────────────────────────────────────────────────────────────
# Test 9: Version action includes baseline SHA in debug
# ──────────────────────────────────────────────────────────────────────────────

echo ""
echo "Test 9: Version action includes baseline SHA in debug"

VERSION_RESULT=$(node "$PROJECT_ROOT/bin/oddkit" version -r "$TEMP_DIR" 2>/dev/null) || true

if echo "$VERSION_RESULT" | grep -q '"baseline_sha"'; then
  pass "version debug includes baseline_sha"
else
  fail "version debug missing baseline_sha"
fi

# ──────────────────────────────────────────────────────────────────────────────
# Summary
# ──────────────────────────────────────────────────────────────────────────────

echo ""
echo "============================================="
echo "Results: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
  echo "VERDICT: FAIL"
  exit 1
else
  echo "VERDICT: PASS"
  exit 0
fi
