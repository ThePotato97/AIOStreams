#!/bin/sh
# Builds atmos-render as WebAssembly for the web app's in-browser binaural rendering, into
# packages/web/src/lib/playback/binaural/atmos_render.wasm (not committed). Needs Rust with the
# wasm32-unknown-unknown target. Without the file the web app builds as before and leaves
# binaural rendering to the transcoder.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root/services/atmos-render"
cargo build --lib --release --locked --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/atmos_render.wasm \
  "$root/packages/web/src/lib/playback/binaural/atmos_render.wasm"
