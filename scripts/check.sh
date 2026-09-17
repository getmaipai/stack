#!/usr/bin/env bash
# MaiPai Stack pre-commit gate. Today the repo is docs only, so this runs
# the pinned @maipai/standards core (gitleaks, PII wordlist, prose lint,
# licence check). STACK-01 adds the repo's own lint, format and tests in
# front of it, keeping --docs as the gate for a Markdown-only commit.
set -euo pipefail
cd "$(dirname "$0")/.."

STANDARDS_DIR="${MAIPAI_STANDARDS_DIR:-../.github}"
STANDARDS_DIR="$(cd "$STANDARDS_DIR" && pwd)"
export MAIPAI_STANDARDS_DIR="$STANDARDS_DIR"

if [ "${1:-}" != "--docs" ]; then
  echo "== stack: no code yet; running the standards core only"
fi

bash "$STANDARDS_DIR/standards/bin/check-core.sh" .
