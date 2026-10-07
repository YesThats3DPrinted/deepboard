#!/bin/bash
# Runs the whiteboard locally on http://localhost:60379
#
# Node 18 is not optional: the build tools this app uses are from 2022 and
# break on newer Node.
set -e
export PATH="$HOME/.local/node18/bin:$PATH"
cd "$(dirname "$0")/apps/client"
exec pnpm run dev:spa
