# Source this to use Node 18 + pnpm 7.6.0 (the versions this repo needs).
# Newer Node breaks pnpm 7's registry calls with ERR_INVALID_THIS.
export PATH="$HOME/.local/node18/bin:$PATH"
export COREPACK_ENABLE_STRICT=0
