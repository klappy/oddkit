#!/usr/bin/env bash
set -euo pipefail

# Catalog + discoverability regression tests
# 1) "what's in ODD?" -> action catalog
# 2) menu contains Start here / Next up / Top canon by tag / Operational playbooks
# 3) "what is epistemic challenge?" -> action librarian
# 4) explain --last shows last tool was catalog (minimal)

echo "Orchestrate catalog tests"
echo "========================="

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Test 1a: "what's in ODD?" -> catalog
echo ""
echo "Test 1a: 'what's in ODD?' -> action catalog"
RESULT=$(node -e "
import('file://$PROJECT_ROOT/src/mcp/orchestrate.js').then((mod) => {
  const { action, reason } = mod.detectAction(\"what's in ODD?\");
  console.log(JSON.stringify({ action, reason }));
}).catch(err => {
  console.log(JSON.stringify({ error: err.message }));
});
" 2>&1)
ACTUAL=$(echo "$RESULT" | grep -o '"action":"[^"]*"' | cut -d'"' -f4)
if [ "$ACTUAL" = "catalog" ]; then
  echo "PASS: what's in ODD -> catalog"
else
  echo "FAIL: expected action catalog, got $ACTUAL"
  echo "$RESULT"
  exit 1
fi

# Test 1b: "list the canon" -> catalog
echo ""
echo "Test 1b: 'list the canon' -> action catalog"
RESULT1b=$(node -e "
import('file://$PROJECT_ROOT/src/mcp/orchestrate.js').then((mod) => {
  const { action } = mod.detectAction('list the canon');
  console.log(JSON.stringify({ action }));
}).catch(err => {
  console.log(JSON.stringify({ error: err.message }));
});
" 2>&1)
ACTUAL1b=$(echo "$RESULT1b" | grep -o '"action":"[^"]*"' | cut -d'"' -f4)
if [ "$ACTUAL1b" = "catalog" ]; then
  echo "PASS: list the canon -> catalog"
else
  echo "FAIL: expected action catalog, got $ACTUAL1b"
  echo "$RESULT1b"
  exit 1
fi

# Test 2: menu contains required sections (needs index + runOrchestrate)
echo ""
echo "Test 2: menu contains Start here / Next up / Top canon by tag / Operational playbooks"
# Build index (uses default baseline)
node "$PROJECT_ROOT/bin/oddkit" index --repo "$PROJECT_ROOT" > /dev/null 2>&1 || true

RUN=$(node -e "
import('file://$PROJECT_ROOT/src/mcp/orchestrate.js').then(async (mod) => {
  const r = await mod.runOrchestrate({
    message: \"what's in ODD?\",
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

for section in "Start here:" "Next up:" "Top canon by tag:" "Operational playbooks:"; do
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

# Test 3: non-catalog queries still route to librarian
echo ""
echo "Test 3: 'what is epistemic challenge?' -> action librarian"
RESULT3=$(node -e "
import('file://$PROJECT_ROOT/src/mcp/orchestrate.js').then((mod) => {
  const { action, reason } = mod.detectAction('what is epistemic challenge?');
  console.log(JSON.stringify({ action, reason }));
}).catch(err => {
  console.log(JSON.stringify({ error: err.message }));
});
" 2>&1)
ACTUAL3=$(echo "$RESULT3" | grep -o '"action":"[^"]*"' | cut -d'"' -f4)
if [ "$ACTUAL3" = "librarian" ]; then
  echo "PASS: non-catalog -> librarian"
else
  echo "FAIL: expected action librarian, got $ACTUAL3"
  echo "$RESULT3"
  exit 1
fi

# Test 4: explain --last shows last tool was catalog
echo ""
echo "Test 4: explain --last shows last tool was catalog"
# Last run was catalog (from Test 2)
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
if [ "$TOOL" = "catalog" ]; then
  echo "PASS: explain last tool = catalog"
else
  echo "FAIL: expected explain tool catalog, got $TOOL"
  echo "$EXPLAIN_JSON" | head -50
  exit 1
fi

echo ""
echo "========================="
echo "All catalog tests passed!"
