#!/bin/bash
# file-unlock.sh — PostToolUse hook: release file lock after editing is done
#
# Called after Edit/Write/MultiEdit/NotebookEdit completes.
# Releases the lock so other waiting Claude instances can proceed.

set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
LOCK_DIR="$REPO_ROOT/.claude/locks"

# ── 1. Parse file path from stdin JSON ───────────────────────────────────────
INPUT=$(cat)

FILE_PATH=$(python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
    ti = d.get('tool_input', {})
    print(ti.get('file_path', '') or ti.get('notebook_path', ''))
except Exception:
    print('')
" <<< "$INPUT" 2>/dev/null)

[ -z "$FILE_PATH" ] && exit 0

# ── 2. Normalize to absolute path ────────────────────────────────────────────
if [[ "$FILE_PATH" != /* ]]; then
    FILE_PATH="$REPO_ROOT/$FILE_PATH"
fi
FILE_PATH=$(python3 -c "import os; print(os.path.realpath('$FILE_PATH'))" 2>/dev/null || echo "$FILE_PATH")

# ── 3. Get our Claude Code session PID ───────────────────────────────────────
get_claude_pid() {
    local pid=$PPID
    for _ in 1 2 3 4 5; do
        local cmd
        # macOS ps -o comm= may return full path (e.g. /Users/.../.local/bin/claude)
        # Use basename so "^claude|^node" matches regardless of install path
        cmd=$(basename "$(ps -p "$pid" -o comm= 2>/dev/null | tr -d ' ')" 2>/dev/null)
        if echo "$cmd" | grep -qiE "^claude|^node"; then
            echo "$pid"; return
        fi
        local ppid
        ppid=$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ')
        [ -z "$ppid" ] || [ "$ppid" -le 1 ] && break
        pid=$ppid
    done
    echo "$PPID"
}
MY_PID=$(get_claude_pid)

# ── 4. Release lock if we own it ─────────────────────────────────────────────
md5_hash() { python3 -c "import hashlib,sys; print(hashlib.md5(sys.argv[1].encode()).hexdigest())" "$1"; }
LOCK_HASH=$(md5_hash "$FILE_PATH")
LOCK_FILE="$LOCK_DIR/${LOCK_HASH}.lock"

if [ -f "$LOCK_FILE" ]; then
    LOCK_PID=$(awk '{print $1}' "$LOCK_FILE" 2>/dev/null || echo "")
    if [ "$LOCK_PID" = "$MY_PID" ]; then
        rm -f "$LOCK_FILE"
    fi
fi

exit 0
