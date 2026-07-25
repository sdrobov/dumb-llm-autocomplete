#!/usr/bin/env bash
# Build and launch VS Code with this extension loaded as an Extension Development Host.
# Requires the `code` CLI on PATH (VS Code → Cmd+Shift+P → "Shell Command: Install 'code' command in PATH").
#
# Usage:
#   ./scripts/dev.sh           # build + smoke + launch
#   ./scripts/dev.sh --no-smoke
#   ./scripts/dev.sh --no-launch   # build only

set -euo pipefail

cd "$(dirname "$0")/.."

run_smoke=1
run_launch=1
for arg in "$@"; do
    case "$arg" in
        --no-smoke)  run_smoke=0 ;;
        --no-launch) run_launch=0 ;;
        -h|--help)
            sed -n '2,9p' "$0"
            exit 0 ;;
        *) echo "unknown flag: $arg" >&2; exit 2 ;;
    esac
done

echo "==> tsc"
npm run build

if [ "$run_smoke" -eq 1 ]; then
    echo "==> smoke"
    npm run smoke
fi

if [ "$run_launch" -eq 1 ]; then
    if ! command -v code >/dev/null 2>&1; then
        echo "error: 'code' CLI not found on PATH." >&2
        echo "  install it: VS Code → Cmd+Shift+P → 'Shell Command: Install code command in PATH'" >&2
        exit 1
    fi
    # -n opens a new window so we don't reuse the user's editor with stale state.
    echo "==> launching Extension Development Host"
    exec code -n --extensionDevelopmentPath="$PWD" "$PWD"
fi