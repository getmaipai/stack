#!/bin/bash
# COMPOSITE-SWAP-01 regression run (a bench, never the gate): composites one donor segment over its source with the worker and prints the report.
# usage: composite-swap-regression.sh <python with numpy+opencv> <source.mp4> <donor.mp4> <start seconds> [caption x,y,w,h]
# Regression cases (private clips, kept in the Home repo's data-scratch/swap-composite/regression-batman): the cowl-ripped clip, the cartoon swap, the sitcom swap.
set -e
PY=$1; SRC=$2; DON=$3; START=${4:-0}; BOX=$5
OUT=$(mktemp -d)/composite.mp4
"$PY" "$(dirname "$0")/../../backend/src/video/composite_swap_worker.py" --source "$SRC" --donor "$DON" --out "$OUT" --start "$START" ${BOX:+--caption-box "$BOX"} --report "$OUT.json"
echo "composite: $OUT"; echo "report: $OUT.json"
