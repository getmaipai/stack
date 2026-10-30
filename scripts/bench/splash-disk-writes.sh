#!/usr/bin/env bash
# Bench (not part of the gate): bytes and file paths Splash holds under its tmp folder over a window.
# usage: splash-disk-writes.sh <splash-tmp-dir> [seconds=60]
# Prints sizes and paths only, never file contents.
set -u
dir="${1:?splash tmp dir}"; secs="${2:-60}"
size() { du -sk "$dir" 2>/dev/null | awk '{print $1*1024}'; }
a=$(size); sleep "$secs"; b=$(size)
echo "splash tmp bytes: start=${a:-0} end=${b:-0} over ${secs}s"
find "$dir" -type f -exec stat -f '%z %N' {} + 2>/dev/null | sort -rn | head -10
