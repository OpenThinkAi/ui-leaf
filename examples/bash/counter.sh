#!/usr/bin/env bash
# Worked example: a Bash "CLI" driving ui-leaf via the language-neutral
# `ui-leaf mount` binary. Demonstrates the full stdio JSON protocol
# including a mutation round-trip.
#
# This script loads `examples/views/counter.tsx` — the shared counter view
# used by all three examples (bash, python, node).
#
# Run from the repo root:
#   ./examples/bash/counter.sh
#
# Or from a project that has ui-leaf installed:
#   /path/to/counter.sh
#
# When the browser opens, click "+1" or "-1". Each click emits a `mutate`
# event that this script handles in Bash, updates a counter variable, and
# writes the new value back as a `result` event. Close the browser tab to exit.
#
# Smoke mode (no browser, exits cleanly — used by CI):
#   UI_LEAF_SMOKE=1 ./examples/bash/counter.sh
#
# Environment variables:
#   UI_LEAF_SMOKE=1        Headless mode: openBrowser=false, sends an update,
#                          closes cleanly, exits 0.
#   UI_LEAF_BIN=<path>     Override the binary path.
#   UI_LEAF_VIEWS_ROOT=<p> Override the views directory.
#
# Note: this script parses JSON events with jq (preferred) or sed (fallback).
# Real consumers should use a proper JSON parser for robustness.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Resolve the views directory: prefer the explicit env override, then the
# shared examples/views directory relative to this script's location.
VIEWS_ROOT="${UI_LEAF_VIEWS_ROOT:-${SCRIPT_DIR}/../views}"
VIEWS_ROOT="$(cd "$VIEWS_ROOT" && pwd)"

# Pick the binary: prefer the explicit env override, then a local dist build
# (during development), then whatever is on PATH.
if [ -n "${UI_LEAF_BIN:-}" ]; then
  UI_LEAF_BIN_CMD=("$UI_LEAF_BIN")
elif [ -x "${SCRIPT_DIR}/../../packages/cli/dist/cli.js" ]; then
  UI_LEAF_BIN_CMD=("node" "${SCRIPT_DIR}/../../packages/cli/dist/cli.js")
else
  UI_LEAF_BIN_CMD=("ui-leaf")
fi

# Counter state lives here in the parent (Bash) process. The view never sees
# the count directly — only the value returned through mutation `result` events
# (and the initial `data.initialCount`).
COUNT=0

# Headless/smoke mode: suppress browser open so CI can run without a display.
OPEN_BROWSER="true"
if [ "${UI_LEAF_SMOKE:-0}" = "1" ]; then
  OPEN_BROWSER="false"
fi

# Build the initial config (line 1 of stdin to ui-leaf mount).
#
# Protocol fields:
#   version      — required on every message; "1" for v1.0.0.
#   view         — view name (resolves to <viewsRoot>/counter.tsx).
#   viewsRoot    — absolute path to the directory that contains view files.
#   data         — initial props passed to the React view.
#   mutations    — list of mutation names the view is allowed to call.
#   port         — 0 → OS assigns a free port (reported back in the ready event).
#   openBrowser  — false in smoke mode so the harness can run headless.
CONFIG=$(printf \
  '{"version":"1","view":"counter","viewsRoot":"%s","data":{"initialCount":%d},"mutations":["increment"],"port":0,"openBrowser":%s}' \
  "$VIEWS_ROOT" "$COUNT" "$OPEN_BROWSER")

# json_field <json> <key>  — extract a scalar string or number from a JSON line.
# Prefers jq when available; falls back to sed for zero-dependency environments.
json_field() {
  local json="$1" key="$2"
  if command -v jq &>/dev/null; then
    # Herestring avoids piping through printf so % characters in the JSON
    # are not treated as format specifiers by any intermediate shell layer.
    jq -r --arg k "$key" '.[$k] // empty' <<<"$json"
  else
    # Illustrative fallback — handles simple unescaped strings and integers.
    sed -nE "s/.*\"${key}\":\"?([^\",}]+)\"?.*/\1/p" <<<"$json"
  fi
}

# Use coproc so we can both read from and write to the binary's stdio without
# a named pipe. UILEAF[0] = binary stdout fd; UILEAF[1] = binary stdin fd.
coproc UILEAF { "${UI_LEAF_BIN_CMD[@]}" mount; }

# Line 1 of stdin is the config object. All subsequent lines are either
# mutation responses (result/error) or live-update messages (update/close/…).
echo "$CONFIG" >&"${UILEAF[1]}"
echo "[bash] sent config; waiting for events…" >&2

# Clean up the coproc on SIGTERM so the process tree doesn't linger.
trap 'kill "$UILEAF_PID" 2>/dev/null; exit 0' SIGTERM SIGINT

# Read events line by line from the binary's stdout.
while IFS= read -r line <&"${UILEAF[0]}"; do
  TYPE="$(json_field "$line" "type")"

  case "$TYPE" in
    ready)
      # The binary is listening and the view URL is known.
      URL="$(json_field "$line" "url")"
      echo "[bash] view ready at ${URL}" >&2

      if [ "${UI_LEAF_SMOKE:-0}" = "1" ]; then
        # Smoke mode: push a data update to exercise the update path, then
        # request a clean close. The binary will emit a `closed` event.
        echo '{"version":"1","type":"update","data":{"initialCount":42}}' >&"${UILEAF[1]}"
        echo '{"version":"1","type":"close"}' >&"${UILEAF[1]}"
      fi
      ;;

    mutate)
      # The browser clicked a button — handle the mutation on the CLI side.
      ID="$(json_field "$line" "id")"
      NAME="$(json_field "$line" "name")"
      # `by` is nested under `args`; jq reads it correctly; sed fallback reads
      # the raw value from the flattened line (works for simple integer args).
      if command -v jq &>/dev/null; then
        BY=$(jq -r '.args.by // 1' <<<"$line")
      else
        BY=$(sed -nE 's/.*"by":(-?[0-9]+).*/\1/p' <<<"$line")
        BY="${BY:-1}"
      fi

      if [ "$NAME" = "increment" ]; then
        COUNT=$((COUNT + BY))
        echo "[bash] mutation '${NAME}' by=${BY} → count=${COUNT}" >&2
        # Result must carry the same `id` as the mutate event so the view can
        # pair the response with the pending promise.
        printf '{"version":"1","type":"result","id":%s,"value":{"count":%d}}\n' \
          "$ID" "$COUNT" >&"${UILEAF[1]}"
      else
        printf '{"version":"1","type":"error","id":%s,"message":"unknown mutation: %s"}\n' \
          "$ID" "$NAME" >&"${UILEAF[1]}"
      fi
      ;;

    closed)
      echo "[bash] view closed" >&2
      break
      ;;

    error)
      MSG="$(json_field "$line" "message")"
      echo "[bash] error: ${MSG}" >&2
      break
      ;;
  esac
done

wait "$UILEAF_PID" 2>/dev/null || true
echo "[bash] done." >&2
