#!/bin/bash
# Runs the whiteboard on this machine at http://localhost:60379
#
# Node 18 is not optional. The build tools this app uses are from 2022 and
# newer Node breaks their downloads with ERR_INVALID_THIS.
set -e

NODE18="$HOME/.local/node18/bin"

if [ ! -x "$NODE18/node" ]; then
  echo "Node 18 is missing. Put it in place with:"
  echo
  echo "  curl -fsSLO https://nodejs.org/dist/v18.20.8/node-v18.20.8-darwin-x64.tar.gz"
  echo "  mkdir -p ~/.local/node18"
  echo "  tar -xzf node-v18.20.8-darwin-x64.tar.gz -C ~/.local/node18 --strip-components=1"
  echo "  rm node-v18.20.8-darwin-x64.tar.gz"
  echo "  ~/.local/node18/bin/npm i -g pnpm@7.6.0"
  echo
  exit 1
fi

export PATH="$NODE18:$PATH"

cd "$(dirname "$0")/apps/client"

exec pnpm run dev:spa
