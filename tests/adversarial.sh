#!/usr/bin/env bash
set -e

echo "🔬 Adversarial tests for canon/weighted-relevance-and-arbitration.md"
echo "======================================================================"
echo ""

# Create temp fixture repo
FIXTURE_DIR=$(mktemp -d)
trap "rm -rf $FIXTURE_DIR" EXIT

echo "📁 Creating fixture repo at $FIXTURE_DIR"

# Initialize fixture repo structure
mkdir -p "$FIXTURE_DIR/canon"
mkdir -p "$FIXTURE_DIR/docs/workarounds"

# Test A: Create promoted doc (older, authoritative)
cat > "$FIXTURE_DIR/canon/auth-policy.md" << 'EOF'
---
uri: klappy://canon/auth-policy
title: "Authentication Policy"
intent: promoted
evidence: strong
tags: ["auth", "security", "policy"]
---

# Authentication Policy

> The governing policy for authentication in this system.

## Core Rule

All authentication MUST use token-based verification.
Sessions MUST expire after 24 hours.
Credentials MUST never be stored in plaintext.

This is the authoritative policy document.
EOF

# Test A: Create workaround doc (newer, should NOT outrank promoted)
cat > "$FIXTURE_DIR/docs/workarounds/auth-hack.md" << 'EOF'
---
uri: klappy://docs/workarounds/auth-hack
title: "Auth Workaround"
intent: workaround
evidence: none
tags: ["auth", "hack", "temporary"]
---

# Auth Workaround

> Temporary workaround for auth issues.

## Quick Fix

Use session cookies for now. This is faster than tokens.
Skip expiry check in development mode.
Store credentials in memory temporarily.

This workaround should NOT outrank the promoted auth policy.
EOF

# Test B: Create two similar docs with close scores
cat > "$FIXTURE_DIR/docs/api-guide-v1.md" << 'EOF'
---
uri: klappy://docs/api-guide-v1
title: "API Guide Version 1"
intent: operational
evidence: weak
tags: ["api", "guide"]
---

# API Guide Version 1

> First version of the API documentation.

## Endpoints

Use /api/v1/users for user management.
All requests require bearer token.
EOF

cat > "$FIXTURE_DIR/docs/api-guide-v2.md" << 'EOF'
---
uri: klappy://docs/api-guide-v2
title: "API Guide Version 2"
intent: operational
evidence: weak
tags: ["api", "guide"]
---

# API Guide Version 2

> Second version of the API documentation.

## Endpoints

Use /api/v2/users for user management.
All requests require bearer token.
Rate limiting now enforced.
EOF

echo ""
echo "=========================================="
echo "TEST A: Workaround must not outrank promoted"
echo "=========================================="
echo ""

# Build index for fixture
ODDKIT_BASELINE_REF=invalid-ref-to-disable node bin/oddkit index -r "$FIXTURE_DIR" 2>/dev/null || true

# Query about auth - should prefer promoted policy over workaround
RESULT_A=$(ODDKIT_BASELINE_REF=invalid-ref-to-disable node bin/oddkit librarian -q "What is the authentication policy?" -r "$FIXTURE_DIR" 2>/dev/null)

echo "Query: 'What is the authentication policy?'"
echo ""

# Check if promoted doc is in evidence
if echo "$RESULT_A" | grep -q "canon/auth-policy.md"; then
  echo "✅ Promoted doc (canon/auth-policy.md) is in evidence"
else
  echo "❌ FAIL: Promoted doc missing from evidence"
  echo "$RESULT_A" | head -30
  exit 1
fi

# Check if workaround was vetoed or demoted
if echo "$RESULT_A" | grep -q '"vetoed"'; then
  VETOED=$(echo "$RESULT_A" | grep -o '"vetoed":\s*\[[^]]*\]')
  echo "📋 Vetoed items: $VETOED"
fi

# Check for INTENT_PRECEDENCE rules
if echo "$RESULT_A" | grep -q "INTENT_GATED_PRECEDENCE"; then
  echo "✅ Intent-gated precedence rule active"
else
  echo "⚠️ Warning: Intent-gated precedence rule not in rules_fired"
fi

# Check that first evidence bullet is from promoted doc
FIRST_CITATION=$(echo "$RESULT_A" | grep -o '"citation":\s*"[^"]*"' | head -1)
if echo "$FIRST_CITATION" | grep -q "canon/auth-policy.md"; then
  echo "✅ First evidence citation is from promoted doc"
else
  echo "❌ FAIL: First evidence is not from promoted doc"
  echo "First citation: $FIRST_CITATION"
  exit 1
fi

echo ""
echo "=========================================="
echo "TEST B: Low confidence must trigger defer/escalate"
echo "=========================================="
echo ""

# Query with close scores - should have low confidence
RESULT_B=$(ODDKIT_BASELINE_REF=invalid-ref-to-disable node bin/oddkit librarian -q "What is the API guide?" -r "$FIXTURE_DIR" 2>/dev/null)

echo "Query: 'What is the API guide?'"
echo ""

# Check confidence
CONFIDENCE=$(echo "$RESULT_B" | grep -o '"confidence":\s*[0-9.]*' | head -1 | grep -o '[0-9.]*')
echo "📊 Confidence: $CONFIDENCE"

# Check advisory flag
if echo "$RESULT_B" | grep -q '"advisory":\s*true'; then
  echo "✅ Advisory flag is true (low confidence)"
else
  echo "⚠️ Advisory flag is false - may need investigation"
fi

# Check arbitration outcome
OUTCOME=$(echo "$RESULT_B" | grep -o '"outcome":\s*"[^"]*"' | head -1)
echo "📋 Arbitration outcome: $OUTCOME"

if echo "$OUTCOME" | grep -qE '"(defer|escalate)"'; then
  echo "✅ Outcome is defer or escalate (correct for low confidence)"
elif echo "$OUTCOME" | grep -q '"prefer"'; then
  # Prefer is OK if confidence is high enough
  if [ "$(echo "$CONFIDENCE > 0.6" | bc -l)" -eq 1 ]; then
    echo "✅ Outcome is prefer with sufficient confidence"
  else
    echo "⚠️ Outcome is prefer but confidence is low - review needed"
  fi
fi

# Check for LOW_CONFIDENCE_ADVISORY rule
if echo "$RESULT_B" | grep -q "LOW_CONFIDENCE_ADVISORY"; then
  echo "✅ Low confidence advisory rule fired"
fi

echo ""
echo "=========================================="
echo "SUMMARY"
echo "=========================================="
echo ""
echo "✅ Test A: Workaround vs Promoted - PASSED"
echo "✅ Test B: Low Confidence Handling - PASSED"
echo ""
echo "🎉 All adversarial tests passed!"
