#!/bin/sh
# Builds the libav.js variant the web app decodes the E-AC-3 core with, for in-browser binaural
# rendering: FFmpeg's AC-3 parser and AC-3/E-AC-3 decoders only, from the libav.js 6.10.9 release
# (its npm package carries its sources: libav.js, FFmpeg 9.0, emfiberthreads), into
# packages/web/src/lib/playback/binaural/libav/ (not committed). Needs Emscripten (libav.js
# builds with 6.0.5: the emscripten/emsdk:6.0.5 image has everything), Node with npm, make and
# pkg-config. Without the files the web app leaves E-AC-3 binaural rendering to the transcoder.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-$root/packages/web/src/lib/playback/binaural/libav}
version=6.10.9
sha256=73f7a945d637c564edb050df7fd329845d4a9f556c6ce019bbcab7d778f16b97
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
npm pack --loglevel=error "libav.js@$version" >/dev/null
echo "$sha256  libav.js-$version.tgz" | sha256sum -c - >/dev/null
tar xzf "libav.js-$version.tgz"
mkdir src
tar xJf package/sources/libav.js.tar.xz -C src
mkdir src/build
cp package/sources/ffmpeg-*.tar.xz package/sources/emfiberthreads-*.tar.gz src/build/
cd src
(cd configs && ./mkconfig.js eac3 '["avcodec","parser-ac3","decoder-ac3","decoder-eac3"]')
npm ci --loglevel=error --no-audit --no-fund >/dev/null
full=$(sed -n 's/^LIBAVJS_VERSION_BASE=//p' Makefile).$(sed -n 's/^FFMPEG_VERSION_MAJOR=//p' Makefile).$(sed -n 's/^FFMPEG_VERSION_MINREV=//p' Makefile)
make -j"$(nproc)" "dist/libav-$full-eac3.mjs" "dist/libav-$full-eac3.wasm.mjs" >build.log 2>&1 || {
  tail -40 build.log
  exit 1
}
mkdir -p "$out"
cp "dist/libav-$full-eac3.mjs" "$out/libav.mjs"
cp "dist/libav-$full-eac3.wasm.mjs" "$out/libav.factory.mjs"
cp "dist/libav-$full-eac3.wasm.wasm" "$out/libav.wasm"
echo "libav.js $full (eac3) in $out"
