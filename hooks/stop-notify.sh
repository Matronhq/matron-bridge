#!/bin/bash
# Stop hook — notifies the matrix bridge that an assistant turn has finished.
# Mirrors the shape of hooks/compact-notify.sh.
INPUT=$(cat)
SID=$(echo "$INPUT" | jq -r '.session_id // empty')
TX=$(echo "$INPUT" | jq -r '.transcript_path // empty')
PORT="${MATRIX_BRIDGE_API_PORT:-9802}"
curl -s --max-time 5 -X POST "http://127.0.0.1:${PORT}/turn-end" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg sid "$SID" --arg tx "$TX" '{session_id:$sid,transcript_path:$tx}')" > /dev/null
exit 0
