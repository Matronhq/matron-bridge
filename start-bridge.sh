#!/bin/bash
cd "$(dirname "$0")"
exec node index.js >> /tmp/matron-bridge.log 2>&1
