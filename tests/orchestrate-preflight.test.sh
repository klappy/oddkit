#!/usr/bin/env bash
set -euo pipefail

# Preflight action regression tests
# 1) "preflight: ..." -> action preflight
# 2) "before I implement..." -> action preflight (direct trigger)
# 3) "implement catalog" -> action preflight (compound trigger)
# 4) "what should I read first" -> action preflight
# 5) assistant_text contains required sections
# 6) explain --last shows last tool was preflight

echo "Orchestrate preflight tests"
echo "==========================="

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Test 1: "preflight: wire catalog" -> preflight
echo ""
echo "Test 1: 'preflight: wire catalog into orchestrate' -> action preflight"
RESULT=$(node -e "
import('file://$PROJECT_ROOT/src/mcp/orchestrate.js').then((mod) => {
  const { action, reason } = mod.detectAction('preflight: I am going to wire catalog into orchestrate');
  console.log(JSON.stringify({ action, reason }));
}).catch(err => {
  console.log(JSON.stringify({ error: err.message }));
});
" 2>&1)
ACTUAL=$(echo "$RESULT" | grep -o '"action":"[^"]*"' | cut -d'"' -f4)
if [ "$ACTUAL" = "preflight" ]; then
  echo "PASS: preflight: -> preflight"
else
  echo "FAIL: expected action preflight, got $ACTUAL"
  echo "$RESULT"
  exit 1
fi

# Test 2: "before I implement" -> preflight (direct trigger)
echo ""
echo "Test 2: 'before I implement the MCP handler' -> action preflight"
RESULT2=$(node -e "
import('file://$PROJECT_ROOT/src/mcp/orchestrate.js').then((mod) => {
  const { action, reason } = mod.detectAction('before I implement the MCP handler');
  console.log(JSON.stringify({ action, reason }));
}).catch(err => {
  console.log(JSON.stringify({ error: err.message }));
});
" 2>&1)
ACTUAL2=$(echo "$RESULT2" | grep -o '"action":"[^"]*"' | cut -d'"' -f4)
if [ "$ACTUAL2" = "preflight" ]; then
  echo "PASS: before I implement -> preflight"
else
  echo "FAIL: expected action preflight, got $ACTUAL2"
  echo "$RESULT2"
  exit 1
fi

# Test 3: "implement catalog" -> preflight (compound trigger: verb + target)
echo ""
echo "Test 3: 'implement catalog action in orchestrate' -> action preflight (compound)"
RESULT3=$(node -e "
import('file://$PROJECT_ROOT/src/mcp/orchestrate.js').then((mod) => {
  const { action, reason } = mod.detectAction('implement catalog action in orchestrate');
  console.log(JSON.stringify({ action, reason }));
}).catch(err => {
  console.log(JSON.stringify({ error: err.message }));
});
" 2>&1)
ACTUAL3=$(echo "$RESULT3" | grep -o '"action":"[^"]*"' | cut -d'"' -f4)
if [ "$ACTUAL3" = "preflight" ]; then
  echo "PASS: implement catalog -> preflight (compound trigger)"
else
  echo "FAIL: expected action preflight, got $ACTUAL3"
  echo "$RESULT3"
  exit 1
fi

# Test 4: "what should I read first" -> preflight
echo ""
echo "Test 4: 'what should I read first?' -> action preflight"
RESULT4=$(node -e "
import('file://$PROJECT_ROOT/src/mcp/orchestrate.js').then((mod) => {
  const { action, reason } = mod.detectAction('what should I read first?');
  console.log(JSON.stringify({ action, reason }));
}).catch(err => {
  console.log(JSON.stringify({ error: err.message }));
});
" 2>&1)
ACTUAL4=$(echo "$RESULT4" | grep -o '"action":"[^"]*"' | cut -d'"' -f4)
if [ "$ACTUAL4" = "preflight" ]; then
  echo "PASS: what should I read first -> preflight"
else
  echo "FAIL: expected action preflight, got $ACTUAL4"
  echo "$RESULT4"
  exit 1
fi

# Test 5: runOrchestrate returns assistant_text with required sections
echo ""
echo "Test 5: runOrchestrate assistant_text contains required sections"
# Build index first
node "$PROJECT_ROOT/bin/oddkit" index --repo "$PROJECT_ROOT" > /dev/null 2>&1 || true

RUN=$(node -e "
import('file://$PROJECT_ROOT/src/mcp/orchestrate.js').then(async (mod) => {
  const r = await mod.runOrchestrate({
    message: 'preflight: implement catalog in orchestrate',
    repoRoot: '$PROJECT_ROOT'
  });
  console.log(JSON.stringify(r));
}).catch(err => {
  console.log(JSON.stringify({ error: err.message }));
});
" 2>&1)

if echo "$RUN" | grep -q '"error"'; then
  echo "FAIL: runOrchestrate error"
  echo "$RUN"
  exit 1
fi

ATEXT=$(echo "$RUN" | node -e "
(async () => {
  const fs = await import('fs');
  const d = fs.readFileSync(0, 'utf8');
  const j = JSON.parse(d);
  console.log(j.assistant_text || '');
})().catch(() => process.exit(1));
" 2>/dev/null || echo "")

# Check for required sections
for section in "Preflight summary" "Start here:" "Next up:"; do
  if echo "$ATEXT" | grep -qF "$section"; then
    echo "PASS: assistant_text contains \"$section\""
  else
    echo "FAIL: assistant_text missing \"$section\""
    echo "--- assistant_text ---"
    echo "$ATEXT"
    echo "---"
    exit 1
  fi
done

# Test 6: Non-preflight queries still route correctly
echo ""
echo "Test 6: 'what is epistemic challenge?' -> action librarian (not preflight)"
RESULT6=$(node -e "
import('file://$PROJECT_ROOT/src/mcp/orchestrate.js').then((mod) => {
  const { action, reason } = mod.detectAction('what is epistemic challenge?');
  console.log(JSON.stringify({ action, reason }));
}).catch(err => {
  console.log(JSON.stringify({ error: err.message }));
});
" 2>&1)
ACTUAL6=$(echo "$RESULT6" | grep -o '"action":"[^"]*"' | cut -d'"' -f4)
if [ "$ACTUAL6" = "librarian" ]; then
  echo "PASS: non-preflight -> librarian"
else
  echo "FAIL: expected action librarian, got $ACTUAL6"
  echo "$RESULT6"
  exit 1
fi

# Test 7: Catalog queries still route to catalog (not hijacked by preflight)
echo ""
echo "Test 7: 'what\\'s in ODD?' -> action catalog (not preflight)"
RESULT7=$(node -e "
import('file://$PROJECT_ROOT/src/mcp/orchestrate.js').then((mod) => {
  const { action, reason } = mod.detectAction(\"what's in ODD?\");
  console.log(JSON.stringify({ action, reason }));
}).catch(err => {
  console.log(JSON.stringify({ error: err.message }));
});
" 2>&1)
ACTUAL7=$(echo "$RESULT7" | grep -o '"action":"[^"]*"' | cut -d'"' -f4)
if [ "$ACTUAL7" = "catalog" ]; then
  echo "PASS: what's in ODD -> catalog"
else
  echo "FAIL: expected action catalog, got $ACTUAL7"
  echo "$RESULT7"
  exit 1
fi

# Test 8: explain --last shows last tool was preflight
echo ""
echo "Test 8: explain --last shows last tool was preflight"
# Last run was preflight (from Test 5)
EXPLAIN_JSON=$(node -e "
import('file://$PROJECT_ROOT/src/explain/explain-last.js').then((mod) => {
  const j = mod.explainLast({ format: 'json' });
  console.log(JSON.stringify(j));
}).catch(err => {
  console.log(JSON.stringify({ error: err.message }));
});
" 2>&1)

if echo "$EXPLAIN_JSON" | grep -q '"error"'; then
  echo "FAIL: explain error"
  echo "$EXPLAIN_JSON"
  exit 1
fi

TOOL=$(echo "$EXPLAIN_JSON" | node -e "
(async () => {
  const fs = await import('fs');
  const d = fs.readFileSync(0, 'utf8');
  const j = JSON.parse(d);
  const t = j._explain?.tool ?? j.debug?.tool ?? '';
  console.log(t);
})().catch(() => process.exit(1));
" 2>/dev/null || echo "")
if [ "$TOOL" = "preflight" ]; then
  echo "PASS: explain last tool = preflight"
else
  echo "FAIL: expected explain tool preflight, got $TOOL"
  echo "$EXPLAIN_JSON" | head -50
  exit 1
fi

echo ""
echo "==========================="
echo "All preflight tests passed!"
