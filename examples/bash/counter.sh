#!/usr/bin/env bash
# Worked example: a Bash "CLI" driving ui-leaf via the language-neutral
# `ui-leaf mount` binary. Demonstrates the full stdio JSON protocol
# including a mutation round-trip.
#
# This script loads `views/demo.tsx` (the example view shipped with
# the repo). The view exposes +1 / -1 buttons that call the
# `increment` mutation declared below.
#
# Run from the repo root:
#   ./examples/bash/counter.sh
#
# Or from a project that has ui-leaf installed (npm i -g ui-leaf):
#   /path/to/counter.sh
#
# When the browser opens, click "+1" or "-1". Each click emits a
# `mutate` event that this script handles in Bash, updates a counter
# variable, and writes the new value back as a `result` event. Close
# the browser tab to exit.
#
# Note: this script parses JSON events with `sed` to keep dependencies
# minimal. Real consumers should use a proper JSON parser (`jq` here,
# or your language's stdlib elsewhere) rather than copying the regexes.

set -e

# Resolve viewsRoot to the repo's views directory if running from the repo,
# otherwise expect the caller to set UI_LEAF_VIEWS_ROOT.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VIEWS_ROOT="${UI_LEAF_VIEWS_ROOT:-${SCRIPT_DIR}/../../views}"
VIEWS_ROOT="$(cd "$VIEWS_ROOT" && pwd)"

# Pick the binary: prefer the local dist build (during development), fall
# back to whatever's on PATH (e.g. `npm i -g ui-leaf`).
if [ -x "${SCRIPT_DIR}/../../dist/cli.js" ]; then
  UI_LEAF_BIN=("node" "${SCRIPT_DIR}/../../dist/cli.js")
else
  UI_LEAF_BIN=("ui-leaf")
fi

# Counter state lives in the parent (this Bash script) — the view never
# sees the count directly, only what comes back through `data` (initial)
# and mutation `result` events (subsequent).
COUNT=0

# Build the initial config. `mutations: ["increment"]` declares the names
# the view is allowed to call.
read -r -d '' CONFIG <<EOF || true
{"view":"demo","viewsRoot":"${VIEWS_ROOT}","data":{"initialCount":${COUNT}},"mutations":["increment"],"port":0,"heartbeatTimeoutMs":10000}
EOF

# Use coproc so we can both read from and write to the binary's stdio.
coproc UILEAF { "${UI_LEAF_BIN[@]}" mount; }

# Send the config as line 1 of stdin.
echo "$CONFIG" >&"${UILEAF[1]}"

echo "[bash] sent config; waiting for events…" >&2

# Read events line by line.
while IFS= read -r line <&"${UILEAF[0]}"; do
  TYPE=$(echo "$line" | sed -nE 's/.*"type":"([^"]+)".*/\1/p')
  case "$TYPE" in
    ready)
      URL=$(echo "$line" | sed -nE 's/.*"url":"([^"]+)".*/\1/p')
      echo "[bash] view ready at $URL — close the tab to exit" >&2
      ;;
    mutate)
      ID=$(echo "$line" | sed -nE 's/.*"id":([0-9]+).*/\1/p')
      NAME=$(echo "$line" | sed -nE 's/.*"name":"([^"]+)".*/\1/p')
      BY=$(echo "$line" | sed -nE 's/.*"by":(-?[0-9]+).*/\1/p')
      BY=${BY:-1}
      if [ "$NAME" = "increment" ]; then
        COUNT=$((COUNT + BY))
        echo "[bash] mutation '${NAME}' by=${BY} → count=${COUNT}" >&2
        echo "{\"type\":\"result\",\"id\":${ID},\"value\":{\"count\":${COUNT}}}" >&"${UILEAF[1]}"
      else
        echo "{\"type\":\"error\",\"id\":${ID},\"message\":\"unknown mutation: ${NAME}\"}" >&"${UILEAF[1]}"
      fi
      ;;
    closed)
      echo "[bash] view closed" >&2
      break
      ;;
    error)
      MSG=$(echo "$line" | sed -nE 's/.*"message":"([^"]+)".*/\1/p')
      echo "[bash] error: ${MSG}" >&2
      break
      ;;
  esac
done

wait $UILEAF_PID 2>/dev/null || true
echo "[bash] done." >&2
