#!/usr/bin/env bash
# Build the Peckboard experts plugin to a WASM module.
# Output: target/wasm32-unknown-unknown/release/peckboard_experts_plugin.wasm
set -euo pipefail
cd "$(dirname "$0")"
rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
cargo build --target wasm32-unknown-unknown --release
WASM="target/wasm32-unknown-unknown/release/peckboard_experts_plugin.wasm"
echo "Built: $WASM"
ls -lh "$WASM"
