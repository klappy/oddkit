#!/bin/bash
#
# promote.sh — Fast-forward main → prod with version gate
#
# Usage:
#   ./scripts/promote.sh              # promote main to prod
#   ./scripts/promote.sh --dry-run    # show what would happen
#
# Pre-conditions:
#   1. You are on the main branch (or specify --force-branch to skip)
#   2. main is up to date with origin/main
#   3. Staging health check passes (set ODDKIT_STAGING_URL to verify)
#   4. prod is fast-forwardable to main
#
# Environment:
#   ODDKIT_STAGING_URL    — Preview deploy URL for main branch (optional)
#   ODDKIT_PRODUCTION_URL — Production URL (default: https://oddkit.klappy.dev)
#
# Design: See docs/decisions/D0001-prod-branch-is-production.md
#         Convention is enforced by tooling, not memory.

set -euo pipefail

PROD_URL="${ODDKIT_PRODUCTION_URL:-https://oddkit.klappy.dev}"
STAGING_URL="${ODDKIT_STAGING_URL:-}"
DRY_RUN=false

for arg in "$@"; do
  case $arg in
    --dry-run) DRY_RUN=true ;;
    --help|-h)
      echo "Usage: ./scripts/promote.sh [--dry-run]"
      echo ""
      echo "Fast-forward main -> prod with version gate."
      echo ""
      echo "Options:"
      echo "  --dry-run   Show what would happen without pushing"
      echo ""
      echo "Environment:"
      echo "  ODDKIT_STAGING_URL     Preview deploy URL (optional, for pre-promotion check)"
      echo "  ODDKIT_PRODUCTION_URL  Production URL (default: https://oddkit.klappy.dev)"
      exit 0
      ;;
  esac
done

echo "oddkit promote: main -> prod"
echo "============================="
echo ""

# ── 1. Branch check ──────────────────────────────────────────────────────────

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ]; then
  echo "ERROR: Must be on main branch (currently on: $BRANCH)"
  echo "  Run: git checkout main"
  exit 1
fi

# ── 2. Ensure main is synced with remote ─────────────────────────────────────

echo "Fetching latest from origin..."
git fetch origin --quiet

LOCAL=$(git rev-parse main)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" != "$REMOTE" ]; then
  echo "ERROR: main is not in sync with origin/main"
  echo "  Local:  $LOCAL"
  echo "  Remote: $REMOTE"
  echo "  Run: git pull origin main"
  exit 1
fi
echo "  main is up to date with origin/main"

# ── 3. Read expected version ─────────────────────────────────────────────────

EXPECTED_VERSION=$(node -p "require('./package.json').version")
echo "  Expected version: $EXPECTED_VERSION"

# ── 4. Staging version gate (optional) ───────────────────────────────────────

if [ -n "$STAGING_URL" ]; then
  echo ""
  echo "Checking staging health: $STAGING_URL/health"
  STAGING_HEALTH=$(curl -sf --max-time 10 "$STAGING_URL/health" 2>/dev/null || echo '{}')
  STAGING_VERSION=$(echo "$STAGING_HEALTH" | python3 -c "import sys, json; print(json.load(sys.stdin).get('version', 'UNAVAILABLE'))" 2>/dev/null || echo "UNAVAILABLE")

  if [ "$STAGING_VERSION" = "UNAVAILABLE" ]; then
    echo "ERROR: Could not reach staging at $STAGING_URL/health"
    echo "  Ensure the preview deploy is live before promoting."
    exit 1
  fi

  if [ "$STAGING_VERSION" != "$EXPECTED_VERSION" ]; then
    echo "ERROR: Staging version mismatch"
    echo "  Staging:  $STAGING_VERSION"
    echo "  Expected: $EXPECTED_VERSION (from package.json)"
    echo ""
    echo "  The preview deploy may still be building, or the version was not bumped."
    exit 1
  fi
  echo "  Staging version matches: $STAGING_VERSION"
fi

# ── 5. Ensure prod exists and can fast-forward ──────────────────────────────

if ! git rev-parse origin/prod >/dev/null 2>&1; then
  echo "ERROR: origin/prod does not exist"
  echo "  Create it first: git push origin main:prod"
  exit 1
fi

PROD_SHA=$(git rev-parse origin/prod)
MAIN_SHA=$(git rev-parse main)

if [ "$PROD_SHA" = "$MAIN_SHA" ]; then
  echo ""
  echo "Nothing to promote — prod is already at main."
  echo "  Both at: $(git rev-parse --short main)"
  exit 0
fi

if ! git merge-base --is-ancestor origin/prod main; then
  echo "ERROR: origin/prod is not an ancestor of main"
  echo "  prod has commits not in main. This should never happen."
  echo "  Manual resolution required."
  exit 1
fi

# ── 6. Show what will be promoted ────────────────────────────────────────────

COMMIT_COUNT=$(git rev-list origin/prod..main --count)
echo ""
echo "Commits to promote: $COMMIT_COUNT"
echo ""
git log --oneline origin/prod..main
echo ""

# ── 7. Promote ───────────────────────────────────────────────────────────────

if [ "$DRY_RUN" = true ]; then
  echo "[DRY RUN] Would push main ($(git rev-parse --short main)) to prod"
  echo "[DRY RUN] No changes made."
  exit 0
fi

echo "Pushing main -> prod (fast-forward)..."
git push origin main:prod

echo ""
echo "Promoted successfully!"
echo "  prod is now at: $(git rev-parse --short main) (v$EXPECTED_VERSION)"

# ── 8. Post-promotion health check ──────────────────────────────────────────

echo ""
echo "Waiting for Cloudflare deploy (15s)..."
sleep 15

echo "Checking production: $PROD_URL/health"
PROD_HEALTH=$(curl -sf --max-time 10 "$PROD_URL/health" 2>/dev/null || echo '{}')
PROD_VERSION=$(echo "$PROD_HEALTH" | python3 -c "import sys, json; print(json.load(sys.stdin).get('version', 'UNAVAILABLE'))" 2>/dev/null || echo "UNAVAILABLE")

if [ "$PROD_VERSION" = "$EXPECTED_VERSION" ]; then
  echo "  Production is live: v$PROD_VERSION"
  echo ""
  echo "Promotion complete."
else
  echo "  WARNING: Production shows v$PROD_VERSION (expected v$EXPECTED_VERSION)"
  echo "  Deploy may still be in progress. Check again in ~30s."
  echo "  URL: $PROD_URL/health"
fi
