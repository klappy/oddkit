#!/bin/bash

# Production deployment test for oddkit Cloudflare Worker
# Tests the live endpoint at oddkit.klappy.dev
#
# Run: npm run test:production
#
# This mirrors the CLI tests but runs against the production Cloudflare Worker.

set -e

echo "oddkit production deployment test"
echo "=================================="

WORKER_URL="${ODDKIT_PRODUCTION_URL:-https://oddkit.klappy.dev}"

echo ""
echo "Testing: $WORKER_URL"
echo ""

# Track pass/fail counts
PASSED=0
FAILED=0

# Helper: make JSON-RPC request to /mcp
mcp_call() {
  local method="$1"
  local params="$2"

  if [ -z "$params" ]; then
    curl -sf "$WORKER_URL/mcp" -X POST \
      -H "Content-Type: application/json" \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\"}"
  else
    curl -sf "$WORKER_URL/mcp" -X POST \
      -H "Content-Type: application/json" \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\",\"params\":$params}"
  fi
}

# Helper: validate JSON response
check_json() {
  local name="$1"
  local json="$2"
  local check_expr="$3"

  # Check valid JSON
  if ! echo "$json" | python3 -c "import sys, json; json.load(sys.stdin)" 2>/dev/null; then
    echo "FAIL - $name: Invalid JSON"
    echo "Output: $json"
    FAILED=$((FAILED + 1))
    return 1
  fi

  # Run additional check if provided
  if [ -n "$check_expr" ]; then
    if ! echo "$json" | python3 -c "import sys, json; d=json.load(sys.stdin); $check_expr" 2>/dev/null; then
      echo "FAIL - $name: Check failed ($check_expr)"
      echo "Output: $json"
      FAILED=$((FAILED + 1))
      return 1
    fi
  fi

  echo "PASS - $name"
  PASSED=$((PASSED + 1))
  return 0
}

# ============================================
# SECTION 1: Health & Connectivity
# ============================================

echo "--- Health & Connectivity ---"
echo ""

# Test 1: Health endpoint returns ok
echo "Test 1: Health endpoint (GET /)"
RESULT=$(curl -sf "$WORKER_URL/" 2>&1) || { echo "FAIL - Health endpoint unreachable"; exit 1; }
check_json "Health endpoint" "$RESULT" "assert d.get('ok') == True, 'ok not true'"

# Test 2: /health alias
echo ""
echo "Test 2: Health alias (GET /health)"
RESULT=$(curl -sf "$WORKER_URL/health" 2>&1) || { echo "FAIL - /health unreachable"; exit 1; }
check_json "Health alias" "$RESULT" "assert d.get('service') == 'oddkit-mcp', 'wrong service'"

# Test 3: Version present
echo ""
echo "Test 3: Version in health response"
VERSION=$(echo "$RESULT" | python3 -c "import sys, json; print(json.load(sys.stdin).get('version', ''))" 2>/dev/null)
if [ -n "$VERSION" ]; then
  echo "PASS - Version: $VERSION"
  PASSED=$((PASSED + 1))
else
  echo "FAIL - No version in health response"
  FAILED=$((FAILED + 1))
fi

# ============================================
# SECTION 2: MCP Protocol
# ============================================

echo ""
echo "--- MCP Protocol ---"
echo ""

# Test 4: Initialize
echo "Test 4: MCP initialize"
RESULT=$(mcp_call "initialize" '{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}')
check_json "MCP initialize" "$RESULT" "assert d.get('result',{}).get('protocolVersion') == '2025-03-26', 'wrong protocol'"

# Test 4b: Initialize returns Mcp-Session-Id header
echo ""
echo "Test 4b: MCP initialize returns Mcp-Session-Id header"
SESSION_HEADER=$(curl -sf "$WORKER_URL/mcp" -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -D - \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' 2>&1 | grep -i "mcp-session-id" || true)
if [ -n "$SESSION_HEADER" ]; then
  echo "PASS - Mcp-Session-Id header present: $SESSION_HEADER"
  PASSED=$((PASSED + 1))
else
  echo "FAIL - Mcp-Session-Id header missing"
  FAILED=$((FAILED + 1))
fi

# Test 4c: GET /mcp with SSE Accept header returns stream
echo ""
echo "Test 4c: GET /mcp with SSE Accept returns text/event-stream"
CONTENT_TYPE=$(curl -sf "$WORKER_URL/mcp" -X GET \
  -H "Accept: text/event-stream" \
  -D - -o /dev/null 2>&1 | grep -i "content-type" | head -1 || true)
if echo "$CONTENT_TYPE" | grep -qi "text/event-stream"; then
  echo "PASS - GET returns text/event-stream: $CONTENT_TYPE"
  PASSED=$((PASSED + 1))
else
  echo "FAIL - GET did not return text/event-stream: $CONTENT_TYPE"
  FAILED=$((FAILED + 1))
fi

# Test 5: tools/list
echo ""
echo "Test 5: MCP tools/list"
RESULT=$(mcp_call "tools/list")
check_json "tools/list" "$RESULT" "assert len(d.get('result',{}).get('tools',[])) >= 3, 'expected 3+ tools'"

# Test 6: resources/list
echo ""
echo "Test 6: MCP resources/list"
RESULT=$(mcp_call "resources/list")
check_json "resources/list" "$RESULT" "assert len(d.get('result',{}).get('resources',[])) >= 1, 'expected resources'"

# Test 7: resources/read
echo ""
echo "Test 7: MCP resources/read (oddkit://instructions)"
RESULT=$(mcp_call "resources/read" '{"uri":"oddkit://instructions"}')
check_json "resources/read" "$RESULT" "assert 'contents' in d.get('result',{}), 'no contents'"

# Test 8: prompts/list
echo ""
echo "Test 8: MCP prompts/list"
RESULT=$(mcp_call "prompts/list")
check_json "prompts/list" "$RESULT" "assert 'prompts' in d.get('result',{}), 'no prompts key'"

# ============================================
# SECTION 3: Tool Calls (oddkit_orchestrate)
# ============================================

echo ""
echo "--- Tool Calls ---"
echo ""

# Test 9: oddkit_orchestrate with librarian action
echo "Test 9: tools/call oddkit_orchestrate (librarian)"
RESULT=$(mcp_call "tools/call" '{"name":"oddkit_orchestrate","arguments":{"message":"What is ODD?","action":"librarian"}}')
check_json "orchestrate librarian" "$RESULT" "assert 'content' in d.get('result',{}), 'no content'"

# Test 10: oddkit_orchestrate with validate action
echo ""
echo "Test 10: tools/call oddkit_orchestrate (validate)"
RESULT=$(mcp_call "tools/call" '{"name":"oddkit_orchestrate","arguments":{"message":"Done with the auth module","action":"validate"}}')
check_json "orchestrate validate" "$RESULT" "assert 'content' in d.get('result',{}), 'no content'"

# Test 11: oddkit_orchestrate with catalog action
echo ""
echo "Test 11: tools/call oddkit_orchestrate (catalog)"
RESULT=$(mcp_call "tools/call" '{"name":"oddkit_orchestrate","arguments":{"message":"What is in ODD?","action":"catalog"}}')
check_json "orchestrate catalog" "$RESULT" "assert 'content' in d.get('result',{}), 'no content'"

# Test 12: oddkit_orchestrate with preflight action
echo ""
echo "Test 12: tools/call oddkit_orchestrate (preflight)"
RESULT=$(mcp_call "tools/call" '{"name":"oddkit_orchestrate","arguments":{"message":"preflight: add user authentication","action":"preflight"}}')
check_json "orchestrate preflight" "$RESULT" "assert 'content' in d.get('result',{}), 'no content'"

# Test 13: oddkit_librarian direct tool
echo ""
echo "Test 13: tools/call oddkit_librarian"
RESULT=$(mcp_call "tools/call" '{"name":"oddkit_librarian","arguments":{"query":"What is epistemic hygiene?"}}')
check_json "oddkit_librarian" "$RESULT" "assert 'content' in d.get('result',{}), 'no content'"

# Test 14: oddkit_validate direct tool
echo ""
echo "Test 14: tools/call oddkit_validate"
RESULT=$(mcp_call "tools/call" '{"name":"oddkit_validate","arguments":{"message":"Done with feature X. Screenshot: x.png"}}')
check_json "oddkit_validate" "$RESULT" "assert 'content' in d.get('result',{}), 'no content'"

# ============================================
# SECTION 4: Response Content Validation
# ============================================

echo ""
echo "--- Response Content Validation ---"
echo ""

# Test 15: Librarian returns assistant_text
echo "Test 15: Librarian response has assistant_text"
RESULT=$(mcp_call "tools/call" '{"name":"oddkit_orchestrate","arguments":{"message":"What is definition of done?","action":"librarian"}}')
# Extract the text content and parse the inner JSON
INNER_JSON=$(echo "$RESULT" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('result',{}).get('content',[{}])[0].get('text',''))" 2>/dev/null)
if echo "$INNER_JSON" | python3 -c "import sys, json; d=json.load(sys.stdin); assert 'assistant_text' in d, 'no assistant_text'" 2>/dev/null; then
  echo "PASS - Librarian has assistant_text"
  PASSED=$((PASSED + 1))
else
  echo "FAIL - Librarian missing assistant_text"
  FAILED=$((FAILED + 1))
fi

# Test 16: Validate response has verdict
echo ""
echo "Test 16: Validate response has verdict"
RESULT=$(mcp_call "tools/call" '{"name":"oddkit_validate","arguments":{"message":"Done with tests"}}')
INNER_JSON=$(echo "$RESULT" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('result',{}).get('content',[{}])[0].get('text',''))" 2>/dev/null)
# verdict is at result.verdict in the inner JSON
if echo "$INNER_JSON" | python3 -c "import sys, json; d=json.load(sys.stdin); assert d.get('result',{}).get('verdict') is not None, 'no verdict'" 2>/dev/null; then
  echo "PASS - Validate has verdict"
  PASSED=$((PASSED + 1))
else
  echo "FAIL - Validate missing verdict"
  FAILED=$((FAILED + 1))
fi

# ============================================
# SECTION 5: Error Handling
# ============================================

echo ""
echo "--- Error Handling ---"
echo ""

# Test 17: Unknown method returns error
echo "Test 17: Unknown method returns error"
RESULT=$(mcp_call "unknown/method")
check_json "Unknown method error" "$RESULT" "assert 'error' in d, 'no error for unknown method'"

# Test 18: Unknown tool returns error
echo ""
echo "Test 18: Unknown tool returns error"
RESULT=$(mcp_call "tools/call" '{"name":"nonexistent_tool","arguments":{}}')
check_json "Unknown tool error" "$RESULT" "assert 'error' in d, 'no error for unknown tool'"

# Test 19: Unknown resource returns error
echo ""
echo "Test 19: Unknown resource returns error"
RESULT=$(mcp_call "resources/read" '{"uri":"oddkit://nonexistent"}')
check_json "Unknown resource error" "$RESULT" "assert 'error' in d, 'no error for unknown resource'"

# ============================================
# Summary
# ============================================

echo ""
echo "=================================="
echo "Production Deployment Test Summary"
echo "=================================="
echo "Passed: $PASSED"
echo "Failed: $FAILED"
echo ""

if [ $FAILED -gt 0 ]; then
  echo "SOME TESTS FAILED"
  exit 1
else
  echo "All production tests passed!"
  exit 0
fi
