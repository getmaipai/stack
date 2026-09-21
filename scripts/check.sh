#!/usr/bin/env bash
# MaiPai Stack pre-commit gate. Checks the @maipai/core and @maipai/spec
# pins against getmaipai/commons, runs the backend's checks, then the
# pinned @maipai/standards core (gitleaks, PII wordlist, prose lint,
# licence check). The standards and commons pins each resolve their own
# immutable per-tag worktree. With --docs it runs only the standards core,
# the gate for a commit that touches only Markdown.
set -euo pipefail
cd "$(dirname "$0")/.."

STANDARDS_REPO="${MAIPAI_STANDARDS_DIR:-../.github}"
STD_TAG="std-v0.3.0"
if [ ! -x "$STANDARDS_REPO/standards/bin/ensure-tag.sh" ]; then
  echo "getmaipai/.github is missing at $STANDARDS_REPO or older than std-v0.3.0 (set MAIPAI_STANDARDS_DIR to a checkout that has standards/bin/ensure-tag.sh)"
  exit 1
fi
STANDARDS_DIR="$(bash "$STANDARDS_REPO/standards/bin/ensure-tag.sh" "$STD_TAG")"
export MAIPAI_STANDARDS_DIR="$STANDARDS_DIR"

# The @maipai/core and @maipai/spec pins, each a full commons tag name
# (core-v0.1.0, spec-v0.1.11). Each resolves to its own immutable per-tag
# worktree via getmaipai/commons's scripts/ensure-tag.sh (SHARED-PIN-01,
# 2026-09-20) instead of reading whatever the commons/ checkout itself
# happens to have checked out - that checkout is one mutable directory
# shared by every session on the machine, and reading it directly let one
# session's `git checkout` there silently detach every other consumer's
# install underneath it. Bumping a pin is two edits - the tag string here
# and the matching file: dependency in backend/package.json (it names the
# same tag in its own path) - then `bun install --force` in backend/ (a
# plain `bun install` does not refresh a file: dependency's snapshot in
# bun's content-addressed store).
if [ "${1:-}" != "--docs" ]; then
  CORE_TAG="core-v0.1.0"
  SPEC_TAG="spec-v0.1.11"
  COMMONS_DIR="${MAIPAI_COMMONS_DIR:-../commons}"
  if [ ! -d "$COMMONS_DIR" ]; then
    echo "getmaipai/commons is missing at $COMMONS_DIR (set MAIPAI_COMMONS_DIR); backend imports @maipai/core and @maipai/spec from its workspaces."
    exit 1
  fi
  COMMONS_DIR="$(cd "$COMMONS_DIR" && pwd)"

  # Resolves one workspace's pin to its tag worktree (creating it via
  # ensure-tag.sh if no consumer has asked for that tag yet, reusing it
  # otherwise) and checks the worktree's own package.json version against
  # the tag name, the same honesty-of-the-pin contract the standards core
  # already uses. Prints the worktree path on stdout.
  ensure_pin() {
    local workspace="$1"
    local tag="$2"
    local expected_version="${tag#"$workspace"-v}"
    local dir
    dir="$(bash "$COMMONS_DIR/scripts/ensure-tag.sh" "$workspace" "$tag")"
    if [ ! -f "$dir/$workspace/package.json" ]; then
      echo "$tag's worktree at $dir has no $workspace/package.json - check the workspace name." >&2
      exit 1
    fi
    local actual_version
    actual_version="$(sed -n 's/^  "version": "\([^"]*\)",$/\1/p' "$dir/$workspace/package.json")"
    if [ "$actual_version" != "$expected_version" ]; then
      echo "@maipai/$workspace at $dir/$workspace is version $actual_version, but its own tag is $tag - the tag was cut against the wrong commit in getmaipai/commons." >&2
      exit 1
    fi
    echo "$dir"
  }

  CORE_DIR="$(ensure_pin core "$CORE_TAG")"
  SPEC_DIR="$(ensure_pin spec "$SPEC_TAG")"
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
