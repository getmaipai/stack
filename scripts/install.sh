#!/usr/bin/env bash
# ADMIN-10: install, update, roll back and remove the MaiPai Stack with no
# Home. macOS uses launchd, Linux uses systemd --user; both come from the
# Stack's own `install-service` command, so this script writes no unit.
#
#   bash install.sh install  --tag v0.1.0     # first install
#   bash install.sh update   --tag v0.2.0     # swap in a newer build, keep the old one
#   bash install.sh rollback                  # go back to the kept build
#   bash install.sh status
#   bash install.sh uninstall [--remove-data]
#
# The only network use is one download of two files from the release:
# SHA256SUMS and maipai-stack-<tag>-<platform>-<arch>.tar.gz, from
# $STACK_RELEASE_BASE_URL/<tag>/ (default: this repo's GitHub releases).
# The tarball's checksum is verified before anything is unpacked, and an
# optional --sha256 pins it against a value you got elsewhere. Nothing
# else is fetched and nothing is sent.
#
# Layout under the prefix (default ~/.maipai-stack):
#   releases/<tag>/   one unpacked build each (binary, admin-ui/, migrations/, backend-src/)
#   current           link to the running build; the service starts it
#   previous          link to the build before the last update (rollback target)
#   data/             the Stack's data (models, database, keys); never touched by update or rollback
#
# Environment: STACK_PREFIX, STACK_PORT (default 8770), STACK_RELEASE_BASE_URL,
# STACK_BUN_BIN (the bun the stt worker runs through; found on PATH if unset),
# STACK_SERVICE_LABEL (default com.maipai.stack).
set -euo pipefail

PINNED_TAG=""   # the release this script ships with; empty means pass --tag
PREFIX="${STACK_PREFIX:-$HOME/.maipai-stack}"
PORT="${STACK_PORT:-8770}"
BASE_URL="${STACK_RELEASE_BASE_URL:-https://github.com/getmaipai/stack/releases/download}"
PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in x86_64) ARCH="x64" ;; aarch64) ARCH="arm64" ;; esac
BINARY="maipai-stack-${PLATFORM}-${ARCH}"

die() { echo "$*" >&2; exit 1; }

CMD="${1:-install}"
[ $# -gt 0 ] && shift
TAG="$PINNED_TAG"; SHA=""; REMOVE_DATA=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="${2:-}"; shift 2 ;;
    --sha256) SHA="${2:-}"; shift 2 ;;
    --prefix) PREFIX="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --remove-data) REMOVE_DATA=1; shift ;;
    *) die "Unknown option $1. See the top of this script for the commands." ;;
  esac
done
PREFIX="$(mkdir -p "$PREFIX" && cd "$PREFIX" && pwd)"
DATA="$PREFIX/data"
CURRENT="$PREFIX/current"
PREVIOUS="$PREFIX/previous"

sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# The Stack's own service commands, run against the current build with the data directory and port set.
stack() {
  STACK_DATA_DIR="$DATA" PORT="$PORT" STACK_SERVICE_PROGRAM="$CURRENT/$BINARY" STACK_BUN_BIN="${STACK_BUN_BIN:-$(command -v bun || true)}" "$CURRENT/$BINARY" "$@"
}

healthy() { for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && return 0; sleep 0.5; done; return 1; }
down() { for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 || return 0; sleep 0.5; done; return 1; }

# Points a link at a release folder in one step.
point() { ln -sfn "$2" "$1.new"; mv -fh "$1.new" "$1" 2>/dev/null || mv -f -T "$1.new" "$1"; }

restart_service() {
  if [ "$PLATFORM" = "darwin" ]; then stack stop >/dev/null || true; down || true; stack start >/dev/null
  else stack stop >/dev/null || true; down || true; stack start >/dev/null; fi
}

fetch_release() {
  [ -n "$TAG" ] || die "No release named. Pass --tag v0.1.0 (the release name from the Stack's releases page)."
  case "$TAG" in v[0-9]*) ;; *) die "A release name looks like v0.1.0, not '$TAG'." ;; esac
  case "$TAG" in *[!A-Za-z0-9._-]*) die "The release name may only hold letters, digits, dots, dashes and underscores." ;; esac
  local tarball="maipai-stack-${TAG}-${PLATFORM}-${ARCH}.tar.gz" work
  work="$(mktemp -d)"
  echo "Downloading $tarball and SHA256SUMS from $BASE_URL/$TAG/"
  curl -fsSL "$BASE_URL/$TAG/SHA256SUMS" -o "$work/SHA256SUMS" || die "Could not download SHA256SUMS for $TAG. Check the release name and your connection."
  curl -fsSL "$BASE_URL/$TAG/$tarball" -o "$work/$tarball" || die "Could not download $tarball. There may be no build for ${PLATFORM}-${ARCH} in $TAG."
  local want got
  want="$(awk -v f="$tarball" '$2==f || $2=="*"f {print $1}' "$work/SHA256SUMS")"
  [ -n "$want" ] || die "SHA256SUMS has no line for $tarball. The release is incomplete; nothing was installed."
  got="$(sha256_of "$work/$tarball")"
  [ "$got" = "$want" ] || die "The download does not match its checksum (got $got, expected $want). Nothing was installed. Try again; if it repeats, the release file is damaged."
  if [ -n "$SHA" ] && [ "$got" != "$SHA" ]; then die "The download does not match the checksum you passed with --sha256. Nothing was installed."; fi
  echo "Checksum verified: $got"
  rm -rf "$PREFIX/releases/$TAG.partial"
  mkdir -p "$PREFIX/releases/$TAG.partial"
  tar -xzf "$work/$tarball" -C "$PREFIX/releases/$TAG.partial" --strip-components=1
  [ -x "$PREFIX/releases/$TAG.partial/$BINARY" ] || die "The download holds no $BINARY. Nothing was installed."
  rm -rf "$PREFIX/releases/$TAG"
  mv "$PREFIX/releases/$TAG.partial" "$PREFIX/releases/$TAG"
  rm -rf "$work"
}

prune() {
  local keep_names=() entry
  for l in "$CURRENT" "$PREVIOUS"; do [ -L "$l" ] && keep_names+=("$(basename "$(readlink "$l")")"); done
  for entry in "$PREFIX"/releases/*; do
    [ -d "$entry" ] || continue
    local n; n="$(basename "$entry")"
    local keepit=0; for k in "${keep_names[@]:-}"; do [ "$k" = "$n" ] && keepit=1; done
    [ "$keepit" = 1 ] || rm -rf "$entry"
  done
}

current_tag() { [ -L "$CURRENT" ] && basename "$(readlink "$CURRENT")" || echo "none"; }

show_next_steps() {
  echo
  echo "The Stack $(current_tag) is running."
  echo "Admin page:  http://127.0.0.1:$PORT/admin/"
  if [ -s "$DATA/admin-setup-code" ]; then echo "First-run setup code (only you can read it): $DATA/admin-setup-code"; echo "  Show it with: cat $DATA/admin-setup-code"; fi
  echo "Update later:   bash $PREFIX/install.sh update --tag <newer release>"
  echo "Go back:        bash $PREFIX/install.sh rollback"
}

case "$CMD" in
  install)
    [ ! -L "$CURRENT" ] || die "A Stack is already installed at $PREFIX ($(current_tag)). Use update to move to a newer build."
    fetch_release
    mkdir -p "$DATA"; chmod 700 "$DATA"
    point "$CURRENT" "releases/$TAG"
    cp "$0" "$PREFIX/install.sh" 2>/dev/null || true
    stack install-service
    healthy || die "The Stack did not answer on port $PORT. See $DATA/logs/stack.error.log, then run: bash $PREFIX/install.sh uninstall"
    for _ in $(seq 1 40); do [ -s "$DATA/admin-setup-code" ] && break; sleep 0.25; done
    show_next_steps ;;
  update)
    [ -L "$CURRENT" ] || die "No Stack is installed at $PREFIX. Run install first."
    old="$(current_tag)"
    [ "$TAG" != "$old" ] || die "$TAG is already the running build."
    fetch_release
    point "$PREVIOUS" "releases/$old"
    point "$CURRENT" "releases/$TAG"
    restart_service
    if ! healthy; then
      echo "The new build did not answer on port $PORT. Going back to $old." >&2
      point "$CURRENT" "releases/$old"; rm -f "$PREVIOUS"
      restart_service; healthy || die "The old build did not answer either. See $DATA/logs/stack.error.log."
      die "Update to $TAG failed and $old is running again. Nothing else changed."
    fi
    prune
    echo "Updated $old to $TAG. The old build is kept for rollback."
    show_next_steps ;;
  rollback)
    [ -L "$PREVIOUS" ] || die "There is no earlier build to go back to."
    cur="$(current_tag)"; prev="$(basename "$(readlink "$PREVIOUS")")"
    [ -d "$PREFIX/releases/$prev" ] || die "The kept build $prev is gone from $PREFIX/releases."
    point "$CURRENT" "releases/$prev"
    point "$PREVIOUS" "releases/$cur"
    restart_service
    healthy || die "$prev did not answer on port $PORT. Run rollback again to return to $cur."
    echo "Rolled back $cur to $prev. $cur is kept; run rollback again to return."
    show_next_steps ;;
  status)
    echo "prefix $PREFIX, running build $(current_tag), previous $( [ -L "$PREVIOUS" ] && basename "$(readlink "$PREVIOUS")" || echo none )"
    [ -L "$CURRENT" ] && stack status | head -5 || true ;;
  uninstall)
    [ -L "$CURRENT" ] || die "No Stack is installed at $PREFIX."
    if [ "$REMOVE_DATA" = 1 ]; then stack uninstall-service --remove-data; else stack uninstall-service; fi
    rm -rf "$PREFIX/releases" "$CURRENT" "$PREVIOUS" "$PREFIX/install.sh"
    echo "Removed the Stack's builds from $PREFIX. $( [ "$REMOVE_DATA" = 1 ] && echo "Data removed too." || echo "Data kept in $DATA." )" ;;
  *) die "Unknown command $CMD. Use install, update, rollback, status or uninstall." ;;
esac
