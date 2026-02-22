#!/bin/bash
# file-lock.sh — PreToolUse hook: wait for file lock, then acquire it
#
# If another Claude Code is editing the file, this hook BLOCKS (sleeps)
# until that Claude's PostToolUse releases the lock. Then acquires it.
# Stale locks (dead PID) are automatically cleared.
#
# Exit 0 = allow tool to proceed (always, after waiting if needed)

set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
LOCK_DIR="$REPO_ROOT/.claude/locks"
mkdir -p "$LOCK_DIR"

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
        cmd=$(ps -p "$pid" -o comm= 2>/dev/null | tr -d ' ')
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

# ── 4. Wait until file is free, then acquire lock ────────────────────────────
# Cross-platform MD5: macOS uses `md5`, Linux uses `md5sum`
md5_hash() { python3 -c "import hashlib,sys; print(hashlib.md5(sys.argv[1].encode()).hexdigest())" "$1"; }
LOCK_HASH=$(md5_hash "$FILE_PATH")
LOCK_FILE="$LOCK_DIR/${LOCK_HASH}.lock"

MAX_WAIT=600  # give up after 10 min (likely a stuck process)
POLL=3        # check every 3 seconds
ELAPSED=0
FIRST_WAIT=true

while true; do
    if [ -f "$LOCK_FILE" ]; then
        LOCK_PID=$(awk '{print $1}' "$LOCK_FILE" 2>/dev/null || echo "")

        # Different session holds the lock?
        if [ -n "$LOCK_PID" ] && [ "$LOCK_PID" != "$MY_PID" ]; then
            if kill -0 "$LOCK_PID" 2>/dev/null; then
                # Process is alive — genuinely locked, wait
                if $FIRST_WAIT; then
                    echo "⏳ '$FILE_PATH' is being edited by Claude Code (PID $LOCK_PID). Waiting..." >&2
                    FIRST_WAIT=false
                fi

                if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
                    echo "⚠️  Lock timeout (${MAX_WAIT}s). Forcing unlock on '$FILE_PATH'." >&2
                    rm -f "$LOCK_FILE"
                    break
                fi

                sleep "$POLL"
                ELAPSED=$((ELAPSED + POLL))
                continue
            fi

            # Dead process — stale lock, clear it
            rm -f "$LOCK_FILE"
        fi
    fi

    # File is free (or owned by us) — break the wait loop
    break
done

# ── 5. Acquire lock ───────────────────────────────────────────────────────────
echo "$MY_PID $FILE_PATH $(date +%s)" > "$LOCK_FILE"
exit 0
