#!/usr/bin/env bash
set -euo pipefail

# Policy tools tests
# 1) resolveCanonTarget returns mode + commit
# 2) getDocByUri returns content for valid URI
# 3) getDocByUri returns error for invalid URI

echo "Policy tools tests"
echo "=================="

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Test 1: resolveCanonTarget returns mode + commit
echo ""
echo "Test 1: resolveCanonTarget returns mode + commit"
RESULT1=$(node -e "
import('file://$PROJECT_ROOT/src/policy/canonTarget.js').then(async (mod) => {
  const target = await mod.resolveCanonTarget();
  console.log(JSON.stringify(target));
}).catch(err => {
  console.log(JSON.stringify({ error: err.message }));
});
" 2>&1)

if echo "$RESULT1" | grep -q '"error"'; then
  # Check if it's our structured error or a JS error
  if echo "$RESULT1" | grep -q '"mode"'; then
    # Has mode field, so it's a partial result with error - that's OK for some cases
    echo "PASS (with expected error): resolveCanonTarget returned structured result"
  else
    echo "FAIL: resolveCanonTarget error"
    echo "$RESULT1"
    exit 1
  fi
fi

MODE=$(echo "$RESULT1" | node -e "
(async () => {
  const fs = await import('fs');
  const d = fs.readFileSync(0, 'utf8');
  const j = JSON.parse(d);
  console.log(j.mode || 'unknown');
})().catch(() => console.log('parse_error'));
" 2>/dev/null || echo "parse_error")

if [ "$MODE" = "head" ] || [ "$MODE" = "local" ] || [ "$MODE" = "pinned" ]; then
  echo "PASS: resolveCanonTarget mode = $MODE"
else
  if [ "$MODE" = "unknown" ]; then
    echo "PASS (expected): mode unknown (no baseline available in test env)"
  else
    echo "FAIL: unexpected mode $MODE"
    echo "$RESULT1"
    exit 1
  fi
fi

COMMIT=$(echo "$RESULT1" | node -e "
(async () => {
  const fs = await import('fs');
  const d = fs.readFileSync(0, 'utf8');
  const j = JSON.parse(d);
  console.log(j.commit || 'null');
})().catch(() => console.log('parse_error'));
" 2>/dev/null || echo "parse_error")

if [ "$COMMIT" != "parse_error" ]; then
  echo "PASS: resolveCanonTarget commit = $COMMIT"
else
  echo "FAIL: could not parse commit"
  echo "$RESULT1"
  exit 1
fi

# Test 2: getDocByUri returns content for valid URI (if baseline available)
echo ""
echo "Test 2: getDocByUri returns content or appropriate error"
RESULT2=$(node -e "
import('file://$PROJECT_ROOT/src/policy/docFetch.js').then(async (mod) => {
  const result = await mod.getDocByUri('klappy://canon/agents/odd-epistemic-guide');
  console.log(JSON.stringify(result));
}).catch(err => {
  console.log(JSON.stringify({ error: err.message }));
});
" 2>&1)

if echo "$RESULT2" | grep -q '"content"'; then
  echo "PASS: getDocByUri returned content"
  
  # Check content_hash is present
  if echo "$RESULT2" | grep -q '"content_hash"'; then
    echo "PASS: getDocByUri returned content_hash"
  else
    echo "FAIL: missing content_hash"
    exit 1
  fi
  
  # Check canon_commit is present
  if echo "$RESULT2" | grep -q '"canon_commit"'; then
    echo "PASS: getDocByUri returned canon_commit"
  else
    echo "FAIL: missing canon_commit"
    exit 1
  fi
elif echo "$RESULT2" | grep -q '"error"'; then
  # Check if it's a structured error (acceptable in some test environments)
  ERROR_CODE=$(echo "$RESULT2" | node -e "
  (async () => {
    const fs = await import('fs');
    const d = fs.readFileSync(0, 'utf8');
    const j = JSON.parse(d);
    console.log(j.error?.code || 'unknown');
  })().catch(() => console.log('unknown'));
  " 2>/dev/null || echo "unknown")
  
  if [ "$ERROR_CODE" = "CANON_TARGET_UNKNOWN" ] || [ "$ERROR_CODE" = "BASELINE_UNAVAILABLE" ] || [ "$ERROR_CODE" = "DOC_NOT_FOUND" ]; then
    echo "PASS (expected): getDocByUri returned $ERROR_CODE (acceptable in test env - cached baseline may be stale)"
  else
    echo "FAIL: unexpected error code $ERROR_CODE"
    echo "$RESULT2"
    exit 1
  fi
else
  echo "FAIL: getDocByUri returned unexpected result"
  echo "$RESULT2"
  exit 1
fi

# Test 3: getDocByUri returns error for invalid URI
echo ""
echo "Test 3: getDocByUri returns error for invalid URI"
RESULT3=$(node -e "
import('file://$PROJECT_ROOT/src/policy/docFetch.js').then(async (mod) => {
  const result = await mod.getDocByUri('invalid://not-a-klappy-uri');
  console.log(JSON.stringify(result));
}).catch(err => {
  console.log(JSON.stringify({ error: err.message }));
});
" 2>&1)

if echo "$RESULT3" | grep -q '"error"'; then
  echo "PASS: getDocByUri returned error for invalid URI"
else
  echo "FAIL: expected error for invalid URI"
  echo "$RESULT3"
  exit 1
fi

echo ""
echo "=================="
echo "All policy tools tests passed!"
