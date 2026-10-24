#!/usr/bin/env bash
# handle-hostinger-pr.sh — repair a Hostinger security-bump PR whose lockfile
# was not regenerated.
#
# Hostinger opens PRs that bump a dependency in package.json but leave
# package-lock.json untouched, so `npm ci` fails with "lockfile out of sync"
# and the whole CI job (build + attestation) never runs.
#
# This script fetches the PR, regenerates the lockfile, verifies the build,
# commits and pushes the lockfile fix back to the PR branch.
#
# Usage:
#   scripts/handle-hostinger-pr.sh <pr-number> [--no-push] [--no-build]
#
# Requires: gh (authenticated), node, npm.

set -euo pipefail

# Always operate from the repository root, regardless of where the script is invoked.
cd "$(dirname "$0")/.."

PR="${1:-}"
if [[ -z "$PR" || ! "$PR" =~ ^[0-9]+$ ]]; then
  echo "Usage: $0 <pr-number> [--no-push] [--no-build]" >&2
  exit 2
fi

PUSH=1
BUILD=1
for arg in "${@:2}"; do
  case "$arg" in
    --no-push) PUSH=0 ;;
    --no-build) BUILD=0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

REPO="Ms-OneNote-Exporter/microsoft-onenote-exporter-web-frontend"
BRANCH=$(gh pr view "$PR" --repo "$REPO" --json headRefName -q .headRefName)

echo "==> Fetching PR #${PR} from ${REPO}"
gh pr view "$PR" --repo "$REPO" >/dev/null

# Refuse to clobber uncommitted work.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: working tree is dirty. Commit or stash first." >&2
  exit 1
fi

# Check out the PR's actual head branch so the push updates the PR.
git fetch origin "$BRANCH" 2>&1 | tail -3
git checkout "$BRANCH"

echo "==> Current diff (package.json)"
git diff origin/main..HEAD -- package.json | head -40

echo "==> Regenerating lockfile"
# npm install reconciles package-lock.json with package.json.
npm install

echo "==> Verifying lockfile is in sync"
npm ci --dry-run >/dev/null 2>&1 || npm ci >/dev/null

if [[ "$BUILD" -eq 1 ]]; then
  echo "==> Typecheck"
  npx tsc -b
  echo "==> Tests"
  npm test
  echo "==> Build"
  VITE_API_ORIGIN=https://one-backend.phttp.com npm run build
  echo "==> Attestation manifest present"
  test -s dist/ASSETS.sha256
fi

if git diff --quiet -- package-lock.json; then
  echo "==> Lockfile already in sync; nothing to commit."
else
  git add package-lock.json
  git commit -m "chore: regenerate lockfile for hostinger security bump (PR #${PR})"
fi

if [[ "$PUSH" -eq 1 ]]; then
  echo "==> Pushing to ${BRANCH}"
  git push --force-with-lease origin "$BRANCH"
  echo "==> Done. Re-run CI on PR #${PR} via: gh pr checks ${PR} --repo ${REPO}"
else
  echo "==> --no-push set; leaving changes local."
fi
