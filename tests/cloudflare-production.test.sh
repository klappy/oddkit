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

WORKER_URL="${1:-${ODDKIT_PRODUCTION_URL:-https://oddkit.klappy.dev}}"

echo ""
echo "Testing: $WORKER_URL"
echo ""

# Track pass/fail counts
PASSED=0
FAILED=0

# Helper: extract JSON from potentially SSE-formatted response
# WorkerTransport (agents SDK) returns SSE by default: "event: message\ndata: {...}\n\n"
extract_json() {
  local response="$1"
  if echo "$response" | grep -q "^data: "; then
    echo "$response" | grep "^data: " | head -1 | sed 's/^data: //'
  else
    echo "$response"
  fi
}

# Helper: make JSON-RPC request to /mcp
# Uses --max-time 30 to prevent curl from hanging indefinitely when
# the Agents SDK responds with SSE (text/event-stream). Without a
# timeout, curl waits forever for the stream to close. Do not remove.
mcp_call() {
  local method="$1"
  local params="$2"
  local response

  if [ -z "$params" ]; then
    response=$(curl -sf --max-time 30 "$WORKER_URL/mcp" -X POST \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\"}")
  else
    response=$(curl -sf --max-time 30 "$WORKER_URL/mcp" -X POST \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\",\"params\":$params}")
  fi

  extract_json "$response"
}

# Helper: validate JSON response
# Always returns 0 so set -e doesn't abort the script on test failure.
# Failures are tracked via the FAILED counter and reported in the summary.
check_json() {
  local name="$1"
  local json="$2"
  local check_expr="$3"

  # Check valid JSON
  if ! echo "$json" | python3 -c "import sys, json; json.load(sys.stdin)" 2>/dev/null; then
    echo "FAIL - $name: Invalid JSON"
    echo "Output: $json"
    FAILED=$((FAILED + 1))
    return 0
  fi

  # Run additional check if provided
  if [ -n "$check_expr" ]; then
    if ! echo "$json" | python3 -c "import sys, json; d=json.load(sys.stdin); $check_expr" 2>/dev/null; then
      echo "FAIL - $name: Check failed ($check_expr)"
      echo "Output: $json"
      FAILED=$((FAILED + 1))
      return 0
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

# Test 1: Root serves chat UI (HTML)
echo "Test 1: Chat UI (GET /)"
CONTENT_TYPE_ROOT=$(curl -sf --max-time 10 "$WORKER_URL/" -D - -o /dev/null 2>&1 | grep -i "content-type" | head -1 || true)
if echo "$CONTENT_TYPE_ROOT" | grep -qi "text/html"; then
  echo "PASS - Root returns text/html"
  PASSED=$((PASSED + 1))
else
  echo "FAIL - Root did not return text/html: $CONTENT_TYPE_ROOT"
  FAILED=$((FAILED + 1))
fi

# Test 1b: Root includes Link header for MCP discovery
echo ""
echo "Test 1b: Root Link header points to MCP endpoint"
LINK_HEADER=$(curl -sf --max-time 10 "$WORKER_URL/" -D - -o /dev/null 2>&1 | grep -i "^link:" | head -1 || true)
if echo "$LINK_HEADER" | grep -qi "mcp"; then
  echo "PASS - Root has Link header with MCP reference: $LINK_HEADER"
  PASSED=$((PASSED + 1))
else
  echo "FAIL - Root missing Link header with MCP reference"
  FAILED=$((FAILED + 1))
fi

# Test 1c: .well-known/mcp.json discovery endpoint
echo ""
echo "Test 1c: MCP discovery (GET /.well-known/mcp.json)"
RESULT=$(curl -sf --max-time 10 "$WORKER_URL/.well-known/mcp.json" 2>&1) || { echo "FAIL - /.well-known/mcp.json unreachable"; FAILED=$((FAILED + 1)); }
if [ -n "$RESULT" ]; then
  check_json "MCP discovery" "$RESULT" "assert 'oddkit' in d.get('mcpServers', {}), 'no oddkit server in mcpServers'"
fi

# Test 1d: .well-known/mcp.json contains correct URL
echo ""
echo "Test 1d: MCP discovery URL points to /mcp"
if [ -n "$RESULT" ]; then
  MCP_URL=$(echo "$RESULT" | python3 -c "import sys, json; print(json.load(sys.stdin).get('mcpServers',{}).get('oddkit',{}).get('url',''))" 2>/dev/null)
  if echo "$MCP_URL" | grep -q "/mcp$"; then
    echo "PASS - Discovery URL ends with /mcp: $MCP_URL"
    PASSED=$((PASSED + 1))
  else
    echo "FAIL - Discovery URL doesn't point to /mcp: $MCP_URL"
    FAILED=$((FAILED + 1))
  fi
fi

# Test 2: /health returns JSON
echo ""
echo "Test 2: Health endpoint (GET /health)"
RESULT=$(curl -sf --max-time 10 "$WORKER_URL/health" 2>&1) || { echo "FAIL - /health unreachable"; exit 1; }
check_json "Health endpoint" "$RESULT" "assert d.get('service') == 'oddkit', 'wrong service'"

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
SESSION_HEADER=$(curl -sf --max-time 30 "$WORKER_URL/mcp" -X POST \
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
CONTENT_TYPE=$(curl -sf --max-time 30 "$WORKER_URL/mcp" -X GET \
  -H "Accept: text/event-stream" \
  -D - -o /dev/null 2>&1 | grep -i "content-type" | head -1 || true)
if echo "$CONTENT_TYPE" | grep -qi "text/event-stream"; then
  echo "PASS - GET returns text/event-stream: $CONTENT_TYPE"
  PASSED=$((PASSED + 1))
else
  echo "FAIL - GET did not return text/event-stream: $CONTENT_TYPE"
  FAILED=$((FAILED + 1))
fi

# Test 4d: GET /mcp without SSE Accept returns 406 Not Acceptable
# WorkerTransport (agents SDK) returns 406 when Accept doesn't include text/event-stream
echo ""
echo "Test 4d: GET /mcp without SSE Accept returns 406 Not Acceptable"
HTTP_STATUS=$(curl -s --max-time 10 -o /dev/null -w "%{http_code}" "$WORKER_URL/mcp" -X GET 2>&1)
if [ "$HTTP_STATUS" = "406" ]; then
  echo "PASS - GET /mcp returns 406 (spec-compliant)"
  PASSED=$((PASSED + 1))
else
  echo "FAIL - GET /mcp returned $HTTP_STATUS (expected 406)"
  FAILED=$((FAILED + 1))
fi

# Test 4e: Initialize response has serverInfo.version (MCP spec: required field)
echo ""
echo "Test 4e: Initialize response has serverInfo.version"
INIT_RESULT=$(mcp_call "initialize" '{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}')
VERSION_FIELD=$(echo "$INIT_RESULT" | python3 -c "import sys, json; d=json.load(sys.stdin); v=d.get('result',{}).get('serverInfo',{}).get('version',''); assert v != '' and v is not None, f'version missing or empty: {v}'; print(v)" 2>&1)
if [ $? -eq 0 ]; then
  echo "PASS - serverInfo.version present: $VERSION_FIELD"
  PASSED=$((PASSED + 1))
else
  echo "FAIL - serverInfo.version missing (causes 424 in strict clients): $VERSION_FIELD"
  FAILED=$((FAILED + 1))
fi

# Test 4f: POST with Accept: text/event-stream returns SSE format
echo ""
echo "Test 4f: POST /mcp with SSE Accept returns text/event-stream"
SSE_RESPONSE=$(curl -sf --max-time 30 "$WORKER_URL/mcp" -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -D /tmp/oddkit_sse_headers \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' 2>&1)
SSE_CT=$(grep -i "content-type" /tmp/oddkit_sse_headers 2>/dev/null | head -1 || true)
if echo "$SSE_CT" | grep -qi "text/event-stream"; then
  echo "PASS - POST with SSE Accept returns text/event-stream"
  PASSED=$((PASSED + 1))
else
  echo "FAIL - POST with SSE Accept returned: $SSE_CT (expected text/event-stream)"
  FAILED=$((FAILED + 1))
fi

# Test 4g: SSE response contains valid JSON-RPC in data field
echo ""
echo "Test 4g: SSE response has event: message + valid JSON-RPC data"
SSE_DATA=$(echo "$SSE_RESPONSE" | grep "^data: " | head -1 | sed 's/^data: //')
if [ -n "$SSE_DATA" ]; then
  if echo "$SSE_DATA" | python3 -c "import sys, json; d=json.load(sys.stdin); assert 'result' in d, 'no result in SSE data'" 2>/dev/null; then
    echo "PASS - SSE data contains valid JSON-RPC response"
    PASSED=$((PASSED + 1))
  else
    echo "FAIL - SSE data is not valid JSON-RPC: $SSE_DATA"
    FAILED=$((FAILED + 1))
  fi
else
  echo "FAIL - No data: field found in SSE response"
  FAILED=$((FAILED + 1))
fi

# Test 4h: Batch JSON-RPC request support
# Note: Agents SDK rejects batch requests that include initialize
# ("Only one initialization request is allowed"), so use tools/list +
# resources/list instead. Drop -f so a 400 doesn't abort under set -e.
echo ""
echo "Test 4h: Batch JSON-RPC request (tools/list + resources/list)"
BATCH_RESPONSE=$(curl -s --max-time 30 "$WORKER_URL/mcp" -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '[{"jsonrpc":"2.0","id":1,"method":"tools/list"},{"jsonrpc":"2.0","id":2,"method":"resources/list"}]' 2>&1)
# Count SSE data lines (should have 2 for batch of 2 requests)
DATA_COUNT=$(echo "$BATCH_RESPONSE" | grep -c "^data: " || true)
if [ "$DATA_COUNT" -ge 2 ]; then
  echo "PASS - Batch request returned $DATA_COUNT SSE events"
  PASSED=$((PASSED + 1))
else
  echo "FAIL - Batch request returned $DATA_COUNT events (expected 2+). Response: $BATCH_RESPONSE"
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
# SECTION 3: Tool Calls (unified oddkit + individual tools)
# ============================================

echo ""
echo "--- Tool Calls ---"
echo ""

# Test 9: oddkit unified tool — search action (was oddkit_orchestrate librarian)
echo "Test 9: tools/call oddkit (action: search)"
RESULT=$(mcp_call "tools/call" '{"name":"oddkit","arguments":{"action":"search","input":"What is ODD?"}}')
check_json "oddkit search" "$RESULT" "assert 'content' in d.get('result',{}), 'no content'"

# Test 10: oddkit unified tool — validate action
echo ""
echo "Test 10: tools/call oddkit (action: validate)"
RESULT=$(mcp_call "tools/call" '{"name":"oddkit","arguments":{"action":"validate","input":"Done with the auth module"}}')
check_json "oddkit validate" "$RESULT" "assert 'content' in d.get('result',{}), 'no content'"

# Test 11: oddkit unified tool — catalog action
echo ""
echo "Test 11: tools/call oddkit (action: catalog)"
RESULT=$(mcp_call "tools/call" '{"name":"oddkit","arguments":{"action":"catalog","input":"list"}}')
check_json "oddkit catalog" "$RESULT" "assert 'content' in d.get('result',{}), 'no content'"

# Test 12: oddkit unified tool — preflight action
echo ""
echo "Test 12: tools/call oddkit (action: preflight)"
RESULT=$(mcp_call "tools/call" '{"name":"oddkit","arguments":{"action":"preflight","input":"preflight: add user authentication"}}')
check_json "oddkit preflight" "$RESULT" "assert 'content' in d.get('result',{}), 'no content'"

# Test 13: oddkit_search direct tool (was oddkit_librarian)
echo ""
echo "Test 13: tools/call oddkit_search"
RESULT=$(mcp_call "tools/call" '{"name":"oddkit_search","arguments":{"input":"What is epistemic hygiene?"}}')
check_json "oddkit_search" "$RESULT" "assert 'content' in d.get('result',{}), 'no content'"

# Test 14: oddkit_validate direct tool (param: input, not message)
echo ""
echo "Test 14: tools/call oddkit_validate"
RESULT=$(mcp_call "tools/call" '{"name":"oddkit_validate","arguments":{"input":"Done with feature X. Screenshot: x.png"}}')
check_json "oddkit_validate" "$RESULT" "assert 'content' in d.get('result',{}), 'no content'"

# ============================================
# SECTION 3b: Epistemic Tools (orient, challenge, gate, encode)
# ============================================

echo ""
echo "--- Epistemic Tool Calls ---"
echo ""

# Test 14b: oddkit_orient
echo "Test 14b: tools/call oddkit_orient"
RAW=$(curl -sf --max-time 30 "$WORKER_URL/mcp" -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"oddkit_orient","arguments":{"input":"I want to add authentication to my app"}}}')
RESULT=$(extract_json "$RAW")
check_json "oddkit_orient" "$RESULT" "assert 'content' in d.get('result',{}), 'no content'"

# Test 14c: oddkit_challenge
echo ""
echo "Test 14c: tools/call oddkit_challenge"
RAW=$(curl -sf --max-time 30 "$WORKER_URL/mcp" -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"oddkit_challenge","arguments":{"input":"We should use MongoDB for everything"}}}')
RESULT=$(extract_json "$RAW")
check_json "oddkit_challenge" "$RESULT" "assert 'content' in d.get('result',{}), 'no content'"

# Test 14d: oddkit_gate
echo ""
echo "Test 14d: tools/call oddkit_gate"
RAW=$(curl -sf --max-time 30 "$WORKER_URL/mcp" -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"oddkit_gate","arguments":{"input":"ready to build the auth module"}}}')
RESULT=$(extract_json "$RAW")
check_json "oddkit_gate" "$RESULT" "assert 'content' in d.get('result',{}), 'no content'"

# Test 14e: oddkit_encode
echo ""
echo "Test 14e: tools/call oddkit_encode"
RAW=$(curl -sf --max-time 30 "$WORKER_URL/mcp" -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"oddkit_encode","arguments":{"input":"We decided to use JWT tokens because they are stateless and scalable"}}}')
RESULT=$(extract_json "$RAW")
check_json "oddkit_encode" "$RESULT" "assert 'content' in d.get('result',{}), 'no content'"

# Test 14f: oddkit_catalog
echo ""
echo "Test 14f: tools/call oddkit_catalog"
RAW=$(curl -sf --max-time 30 "$WORKER_URL/mcp" -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"oddkit_catalog","arguments":{}}}')
RESULT=$(extract_json "$RAW")
check_json "oddkit_catalog" "$RESULT" "assert 'content' in d.get('result',{}), 'no content'"

# ============================================
# SECTION 4: Response Content Validation
# ============================================

echo ""
echo "--- Response Content Validation ---"
echo ""

# Test 15: Search returns assistant_text
echo "Test 15: Search response has assistant_text"
RESULT=$(mcp_call "tools/call" '{"name":"oddkit","arguments":{"action":"search","input":"What is definition of done?"}}')
# Extract the text content and parse the inner JSON
INNER_JSON=$(echo "$RESULT" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('result',{}).get('content',[{}])[0].get('text',''))" 2>/dev/null)
if echo "$INNER_JSON" | python3 -c "import sys, json; d=json.load(sys.stdin); assert 'assistant_text' in d, 'no assistant_text'" 2>/dev/null; then
  echo "PASS - Search has assistant_text"
  PASSED=$((PASSED + 1))
else
  echo "FAIL - Search missing assistant_text"
  FAILED=$((FAILED + 1))
fi

# Test 16: Validate response has verdict
echo ""
echo "Test 16: Validate response has verdict"
RESULT=$(mcp_call "tools/call" '{"name":"oddkit_validate","arguments":{"input":"Done with tests"}}')
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
# MCP spec: unknown tool → result with isError:true (in-band error), not a JSON-RPC error.
# The Agents SDK wraps tool-not-found as {result: {isError: true, content: [...]}}
echo ""
echo "Test 18: Unknown tool returns error"
RESULT=$(mcp_call "tools/call" '{"name":"nonexistent_tool","arguments":{}}')
check_json "Unknown tool error" "$RESULT" "assert d.get('result',{}).get('isError') is True or 'error' in d, 'no error for unknown tool'"

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
echo "Deployment Test Summary ($WORKER_URL)"
echo "=================================="
echo "Passed: $PASSED"
echo "Failed: $FAILED"
echo ""

if [ $FAILED -gt 0 ]; then
  echo "SOME TESTS FAILED"
  exit 1
else
  echo "All tests passed!"
  exit 0
fi
