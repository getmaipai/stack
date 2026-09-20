#!/usr/bin/env bash
# MaiPai Stack pre-commit gate. Runs the backend checks, then the pinned
# @maipai/standards core (gitleaks, PII wordlist, prose lint, licence check).
# Needs getmaipai/commons (the @maipai/core the backend imports) at the
# pinned tag. The standards pin resolves its own immutable worktree.
set -euo pipefail
cd "$(dirname "$0")/.."

STANDARDS_REPO="${MAIPAI_STANDARDS_DIR:-../.github}"
STD_TAG="std-v0.3.0"
STANDARDS_DIR="$(bash "$STANDARDS_REPO/standards/bin/ensure-tag.sh" "$STD_TAG")"
export MAIPAI_STANDARDS_DIR="$STANDARDS_DIR"

# The @maipai/core pin (commons tag core-v0.1.0). Bump this line and the
# file: dependency in backend/package.json together, then `bun install`.
CORE_PIN="0.1.0"
COMMONS_DIR="${MAIPAI_COMMONS_DIR:-../commons}"
if [ ! -f "$COMMONS_DIR/core/package.json" ]; then
  echo "getmaipai/commons is missing at $COMMONS_DIR (set MAIPAI_COMMONS_DIR); the backend imports @maipai/core from its core/ workspace."
  exit 1
fi
CORE_VERSION="$(sed -n 's/^  "version": "\([^"]*\)",$/\1/p' "$COMMONS_DIR/core/package.json")"
if [ "$CORE_VERSION" != "$CORE_PIN" ]; then
  echo "@maipai/core at $COMMONS_DIR/core is version $CORE_VERSION; this repo pins core-v$CORE_PIN. Check out the tag there or move the pin here."
  exit 1
fi

if [ "${1:-}" != "--docs" ]; then
  echo "== backend: install"
  (cd backend && bun install --silent)
  echo "== backend: typecheck"
  (cd backend && bunx tsc --noEmit)

  echo "== backend: API docs, regenerate and check for drift"
  before="$(mktemp)"
  cp docs/api/openapi.json "$before"
  (cd backend && bun run gen:api-docs >/dev/null)
  if ! cmp -s "$before" docs/api/openapi.json; then
    rm -f "$before"
    echo "docs/api/openapi.json was out of date with the route registrations in backend/src/app.ts and its route files; it has been regenerated. Review and commit it."
    exit 1
  fi
  rm -f "$before"

  echo "== backend: components inventory, regenerate and check for drift"
  before="$(mktemp)"
  cp docs/components.md "$before"
  (cd backend && bun run gen:components-doc >/dev/null)
  if ! cmp -s "$before" docs/components.md; then
    rm -f "$before"
    echo "docs/components.md was out of date with roles.ts, engineCatalog.ts, profiles.ts and modelCatalog.ts; it has been regenerated. Review and commit it (bun run gen:components-doc in backend/)."
    exit 1
  fi
  rm -f "$before"

  echo "== backend: tests"
  (cd backend && bun test)
fi

if [ "$(cat "$STANDARDS_DIR/standards/VERSION")" != "${STD_TAG#std-v}" ]; then
  echo "@maipai/standards at $STANDARDS_DIR is $(cat "$STANDARDS_DIR/standards/VERSION"), but the tag is $STD_TAG"
  exit 1
fi

echo "== standards core ($STD_TAG)"
bash "$STANDARDS_DIR/standards/bin/check-core.sh" .
