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

  echo "== backend: API docs, regenerate and check for drift"
  (cd backend && bun run gen:api-docs >/dev/null)
  if ! git diff --quiet -- docs/api; then
    echo "docs/api/ is out of date with the route registrations in backend/src/app.ts and its route files. Run 'bun run gen:api-docs' in backend/ and commit the result."
    git --no-pager diff --stat -- docs/api
    exit 1
  fi

  echo "== backend: tests"
  (cd backend && bun test)

  echo "== frontend: install"
  (cd frontend && bun install --silent)
  echo "== frontend: lint"
  (cd frontend && bun run lint)
  echo "== frontend: tests"
  (cd frontend && bun test)
  echo "== frontend: build"
  (cd frontend && bun run build)
  if [ ! -f frontend/dist/knowledge/pagefind/pagefind-entry.json ]; then
    echo "frontend/dist/knowledge/pagefind/pagefind-entry.json is missing after 'bun run build'."
    exit 1
  fi

  if command -v cargo >/dev/null 2>&1; then
    if [ ! -f desktop/src-tauri/binaries/maipai-stack-aarch64-apple-darwin ]; then
      echo "== desktop: build sidecar"
      bash scripts/build-release.sh --sidecar-only
    fi
    echo "== desktop: cargo check"
    (cd desktop/src-tauri && cargo check)
  else
    echo "== desktop: cargo check skipped (cargo is not installed)"
  fi
fi

bash "$STANDARDS_DIR/standards/bin/check-core.sh" .
