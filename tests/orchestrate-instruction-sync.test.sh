#!/usr/bin/env bash
set -euo pipefail

# Instruction sync routing and validation tests
# Tests the instruction_sync action parameter validation and dispatch

echo "Instruction sync routing tests"
echo "==============================="

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Helper function to test runOrchestrate with specific args
test_orchestrate() {
  local test_name="$1"
  local should_fail="$2"
  local args_json="$3"
  local expected_pattern="$4"

  local result
  result=$(node -e "
    import('file://$PROJECT_ROOT/src/mcp/orchestrate.js').then(async (mod) => {
      try {
        const args = $args_json;
        const result = await mod.runOrchestrate(args);
        console.log(JSON.stringify({ ok: true, result }));
      } catch (err) {
        console.log(JSON.stringify({ ok: false, error: err.message }));
      }
    }).catch(err => {
      console.log(JSON.stringify({ ok: false, error: err.message }));
    });
  " 2>&1)

  local is_ok=$(echo "$result" | grep -o '"ok":[^,}]*' | head -1 | cut -d':' -f2)
  local error_msg=$(echo "$result" | grep -o '"error":"[^"]*"' | cut -d'"' -f4 || true)

  if [ "$should_fail" = "true" ]; then
    if [ "$is_ok" = "false" ]; then
      if echo "$error_msg" | grep -q "$expected_pattern"; then
        echo "PASS: $test_name"
        echo "      Expected error pattern: $expected_pattern"
      else
        echo "FAIL: $test_name"
        echo "      Expected error containing: $expected_pattern"
        echo "      Got error: $error_msg"
        exit 1
      fi
    else
      echo "FAIL: $test_name"
      echo "      Expected failure but got success"
      echo "      Result: $result"
      exit 1
    fi
  else
    if [ "$is_ok" = "true" ]; then
      if echo "$result" | grep -q "$expected_pattern"; then
        echo "PASS: $test_name"
      else
        echo "FAIL: $test_name"
        echo "      Expected pattern: $expected_pattern"
        echo "      Result: $result"
        exit 1
      fi
    else
      echo "FAIL: $test_name"
      echo "      Expected success but got failure"
      echo "      Error: $error_msg"
      exit 1
    fi
  fi
}

echo ""
echo "Test 1: instruction_sync missing both baseline_root and registry_payload => FAIL"
test_orchestrate \
  "missing baseline_root/registry_payload errors" \
  "true" \
  '{"action":"instruction_sync","repoRoot":"."}' \
  "must provide either baseline_root or registry_payload"

echo ""
echo "Test 2: instruction_sync with both baseline_root and registry_payload => FAIL"
test_orchestrate \
  "baseline_root XOR registry_payload enforced" \
  "true" \
  '{"action":"instruction_sync","repoRoot":".","baseline_root":"../klappy.dev","registry_payload":{"version":"1.0.0","instructions":[]}}' \
  "cannot provide both baseline_root and registry_payload"

echo ""
echo "Test 3: Non-sync action without message => FAIL"
test_orchestrate \
  "message required for non-sync actions" \
  "true" \
  '{"action":"orient","repoRoot":"."}' \
  "message is required"

echo ""
echo "Test 4: instruction_sync payload mode with empty registry => SUCCESS"
test_orchestrate \
  "payload mode executes" \
  "false" \
  '{"action":"instruction_sync","repoRoot":".","registry_payload":{"version":"1.0.0","instructions":[]},"state_payload":{"schema_version":"1.0.0","last_sync":null,"dependency_hashes":{},"unresolved":[]}}' \
  '"action":"instruction_sync"'

echo ""
echo "Test 5: state_payload without registry_payload => FAIL"
test_orchestrate \
  "state_payload requires registry_payload" \
  "true" \
  '{"action":"instruction_sync","repoRoot":".","baseline_root":"../klappy.dev","state_payload":{"schema_version":"1.0.0"}}' \
  "state_payload requires registry_payload"

echo ""
echo "==============================="
echo "All instruction_sync routing tests passed!"
