#!/bin/bash
# PreCompact hook — notifies the matrix bridge that compaction is starting
INPUT=$(cat)
SID=$(echo "$INPUT" | jq -r '.session_id // empty')
curl -s -X POST http://127.0.0.1:9802/compact-start \
  -H 'Content-Type: application/json' \
  -d "{\"session_id\":\"$SID\"}" > /dev/null
exit 0
