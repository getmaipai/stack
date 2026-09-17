#!/usr/bin/env bash
# MaiPai Stack pre-commit gate. Runs the backend checks, then the pinned
# @maipai/standards core (gitleaks, PII wordlist, prose lint, licence check).
set -euo pipefail
cd "$(dirname "$0")/.."

STANDARDS_DIR="${MAIPAI_STANDARDS_DIR:-../.github}"
STANDARDS_DIR="$(cd "$STANDARDS_DIR" && pwd)"
export MAIPAI_STANDARDS_DIR="$STANDARDS_DIR"

if [ "${1:-}" != "--docs" ]; then
  echo "== backend: install"
  (cd backend && bun install --silent)
  echo "== backend: typecheck"
  (cd backend && bunx tsc --noEmit)
  echo "== backend: tests"
  (cd backend && bun test)
fi

bash "$STANDARDS_DIR/standards/bin/check-core.sh" .
