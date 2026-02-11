#!/bin/bash
#
# promote.sh — Fast-forward main → prod with tested staging gate
#
# Usage:
#   ODDKIT_STAGING_URL=https://abc123-oddkit.klappy.workers.dev ./scripts/promote.sh
#   ODDKIT_STAGING_URL=... ./scripts/promote.sh --dry-run
#   ./scripts/promote.sh --skip-tests    # emergency only
#
# Pre-conditions:
#   1. You are on the main branch
#   2. main is up to date with origin/main
#   3. ODDKIT_STAGING_URL is set (preview deploy URL from CF dashboard)
#   4. Full test suite passes against staging
#   5. prod is fast-forwardable to main
#
# Environment:
#   ODDKIT_STAGING_URL    — Preview deploy URL for main branch (REQUIRED)
#   ODDKIT_PRODUCTION_URL — Production URL (default: https://oddkit.klappy.dev)
#
# Design: See docs/decisions/D0001-prod-branch-is-production.md
#         Convention is enforced by tooling, not memory.

set -euo pipefail

PROD_URL="${ODDKIT_PRODUCTION_URL:-https://oddkit.klappy.dev}"
STAGING_URL="${ODDKIT_STAGING_URL:-}"
DRY_RUN=false
SKIP_TESTS=false

for arg in "$@"; do
  case $arg in
    --dry-run) DRY_RUN=true ;;
    --skip-tests) SKIP_TESTS=true ;;
    --help|-h)
      echo "Usage: ODDKIT_STAGING_URL=<preview-url> ./scripts/promote.sh [--dry-run] [--skip-tests]"
      echo ""
      echo "Fast-forward main -> prod with full test suite gate."
      echo ""
      echo "Options:"
      echo "  --dry-run      Show what would happen without pushing"
      echo "  --skip-tests   Skip staging tests (emergency only)"
      echo ""
      echo "Environment:"
      echo "  ODDKIT_STAGING_URL     Preview deploy URL (REQUIRED, from CF dashboard > Deployments)"
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

# ── 4. Staging test gate (mandatory) ─────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$SKIP_TESTS" = true ]; then
  echo ""
  echo "  WARNING: --skip-tests flag used. Staging tests SKIPPED."
  echo "  WARNING: You are promoting without verification. Proceed with caution."
  echo ""
elif [ -z "$STAGING_URL" ]; then
  echo ""
  echo "ERROR: ODDKIT_STAGING_URL is required."
  echo ""
  echo "  Get the preview URL from Cloudflare dashboard > Deployments."
  echo "  Preview URLs look like: https://<hash>-oddkit.klappy.workers.dev"
  echo ""
  echo "  Example:"
  echo "    ODDKIT_STAGING_URL=https://abc123-oddkit.klappy.workers.dev ./scripts/promote.sh"
  echo ""
  echo "  To skip tests in an emergency: ./scripts/promote.sh --skip-tests"
  exit 1
else
  echo ""
  echo "Running full test suite against staging: $STAGING_URL"
  echo ""
  if ! bash "$SCRIPT_DIR/tests/cloudflare-production.test.sh" "$STAGING_URL"; then
    echo ""
    echo "ERROR: Staging tests failed. Promotion blocked."
    echo "  Fix the failing tests before promoting to production."
    exit 1
  fi
  echo ""
  echo "  All staging tests passed."
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
