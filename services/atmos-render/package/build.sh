#!/bin/sh
# Builds atmos-render's WebGPU-Player audio decoder packages: truehd.wasm (all Rust), eac3.wasm and
# dts.wasm (Rust with FFmpeg's decoders, linked by Emscripten), with their headers written in
# (pack.mjs), and the notices FFmpeg's LGPL asks for beside them.
#
# FFmpeg is built with the WebGPU player's own recipe (its wgpud/rules.mk and wgpud/eac3/Makefile):
# the same pinned FFmpeg commit, configure line and link flags, with Emscripten 4.0.13.
#
# Runs in emscripten/emsdk:4.0.13 with Rust, git and Node (the Dockerfile's stage), or anywhere those are.
# Usage: build.sh <out dir>
set -eu

FFMPEG_REPOSITORY=https://github.com/FFmpeg/FFmpeg.git
FFMPEG_COMMIT=a59498db085e3d635532397128550141ab87408a
EMSCRIPTEN_VERSION=4.0.13

HERE=$(cd "$(dirname "$0")" && pwd)
CRATE=$(dirname "$HERE")
OUT=$(mkdir -p "$1" && cd "$1" && pwd)
WORK=${ATMOS_PACKAGE_WORK:-$CRATE/target/package}
mkdir -p "$WORK"

emcc --version | grep -qF " $EMSCRIPTEN_VERSION " || {
    echo "Emscripten $EMSCRIPTEN_VERSION is required (the WebGPU player's pinned version)" >&2
    exit 1
}
EMSDK_BIN=$(dirname "$(command -v emcc)")/../bin

# FFmpeg at the pinned commit, fetched once.
FFMPEG_SOURCE=$WORK/ffmpeg-source
if [ "$(git -C "$FFMPEG_SOURCE" rev-parse HEAD 2>/dev/null)" != "$FFMPEG_COMMIT" ]; then
    rm -rf "$FFMPEG_SOURCE"
    git init -q "$FFMPEG_SOURCE"
    git -C "$FFMPEG_SOURCE" fetch -q --depth 1 "$FFMPEG_REPOSITORY" "$FFMPEG_COMMIT"
    git -C "$FFMPEG_SOURCE" checkout -q FETCH_HEAD
fi

# One FFmpeg per package, with only its decoders: <name> <configure components> <decoders config.h must enable>
build_ffmpeg() {
    name=$1; components=$2; expected=$3
    tree=$WORK/ffmpeg-$name
    if [ -f "$tree/libavcodec/libavcodec.a" ]; then return; fi
    rm -rf "$tree"
    cp -a "$FFMPEG_SOURCE" "$tree"
    rm -rf "$tree/.git"
    (cd "$tree" && ./configure --target-os=none --arch=x86_32 --enable-cross-compile --disable-asm \
        --disable-x86asm --disable-inline-asm --disable-programs --disable-doc --disable-debug \
        --disable-all --disable-everything --disable-autodetect \
        --disable-pthreads --disable-runtime-cpudetect --disable-gpl --disable-iconv \
        --disable-version3 --disable-nonfree --enable-avcodec \
        $components \
        --cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib --host-cc="$EMSDK_BIN/clang" --nm="$EMSDK_BIN/llvm-nm" \
        "--extra-cflags=-DNDEBUG -O3 -flto -msimd128" "--extra-ldflags=-O3 -flto" > configure.log 2>&1) \
        || { tail -40 "$tree/configure.log" "$tree/ffbuild/config.log" >&2; exit 1; }
    for marker in 'CONFIG_GPL 0' 'CONFIG_NONFREE 0' 'CONFIG_VERSION3 0'; do
        grep -q "^#define $marker\$" "$tree/config.h" || { echo "FFmpeg $name config.h lacks $marker" >&2; exit 1; }
    done
    enabled=$(sed -n 's/^#define CONFIG_\([A-Z0-9_]*\)_DECODER 1$/\1/p' "$tree/config_components.h" | tr 'A-Z' 'a-z' | sort | tr '\n' ' ')
    [ "$enabled" = "$expected" ] || { echo "FFmpeg $name enabled [$enabled], not [$expected]" >&2; exit 1; }
    make -C "$tree" -j"$(nproc)" > "$tree/make.log" 2>&1 || { tail -40 "$tree/make.log" >&2; exit 1; }
}
build_ffmpeg eac3 --enable-decoder=eac3 "ac3 eac3 "
build_ffmpeg dts --enable-decoder=dca "dca "

# The Rust: TrueHD as a plain module importing its memory; E-AC-3 and DTS as static libraries for Emscripten.
cd "$CRATE"
RUSTFLAGS="-C link-arg=--import-memory -C link-arg=--max-memory=1073741824" \
    cargo build --release --locked --lib --target wasm32-unknown-unknown --features package \
    --target-dir "$WORK/rust-truehd"
for codec in eac3 dts; do
    cargo rustc --release --locked --lib --target wasm32-unknown-emscripten --features "package-$codec" \
        --crate-type staticlib --target-dir "$WORK/rust-$codec"
done

# The engine's audio module link: AUDIO_MODULE_LINK_FLAGS, AUDIO_MODULE_EXPORTS and drain, FFMPEG_AUDIO_LINK_TAIL.
# Rust's Emscripten std unwinds with WebAssembly exceptions, hence -fwasm-exceptions.
EXPORTS=_audio_decoder_abi_version,_audio_decoder_create,_audio_decoder_destroy,_audio_decoder_reserve_input,_audio_decoder_configure,_audio_decoder_set_option,_audio_decoder_send,_audio_decoder_receive,_audio_decoder_frame_count,_audio_decoder_sample_rate,_audio_decoder_channel_count,_audio_decoder_channel_mask,_audio_decoder_channel_pointer,_audio_decoder_timestamp,_audio_decoder_attribute,_audio_decoder_clear,_audio_decoder_error_code,_audio_decoder_error_value,_audio_decoder_drain
for codec in eac3 dts; do
    tree=$WORK/ffmpeg-$codec
    emcc "$HERE/ffcore.c" -I"$tree" -O3 -flto -msimd128 -c -o "$WORK/ffcore-$codec.o"
    emcc "$WORK/ffcore-$codec.o" "$WORK/rust-$codec/wasm32-unknown-emscripten/release/libatmos_render.a" \
        "$tree/libavcodec/libavcodec.a" "$tree/libavutil/libavutil.a" \
        -sSTANDALONE_WASM -sIMPORTED_MEMORY -sFILESYSTEM=0 -sALLOW_MEMORY_GROWTH=1 \
        -sINITIAL_MEMORY=16777216 -sMAXIMUM_MEMORY=268435456 -sMALLOC=emmalloc -sASSERTIONS=0 --no-entry \
        -sEXPORTED_FUNCTIONS=$EXPORTS -fwasm-exceptions -msimd128 -flto -O3 -Wl,--no-entry \
        -o "$WORK/$codec.module.wasm"
done

node "$HERE/pack.mjs" "$CRATE/src/package.rs" truehd "$WORK/rust-truehd/wasm32-unknown-unknown/release/atmos_render.wasm" "$OUT/truehd.wasm"
node "$HERE/pack.mjs" "$CRATE/src/package.rs" eac3 "$WORK/eac3.module.wasm" "$OUT/eac3.wasm"
node "$HERE/pack.mjs" "$CRATE/src/package.rs" dts "$WORK/dts.module.wasm" "$OUT/dts.wasm"

# What FFmpeg's LGPL asks for, beside the packages: its licence, and the corresponding source itself:
# FFmpeg's tree at the pinned commit and this crate (the renderer, ffcore.c, this build), in one archive.
cp "$FFMPEG_SOURCE/COPYING.LGPLv2.1" "$OUT/FFmpeg-COPYING.LGPLv2.1"
SOURCE_TAR=$WORK/atmos-render-source.tar
git -C "$FFMPEG_SOURCE" archive --format=tar --prefix=ffmpeg/ -o "$SOURCE_TAR" "$FFMPEG_COMMIT"
tar -C "$(dirname "$CRATE")" -rf "$SOURCE_TAR" --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
    --exclude="$(basename "$CRATE")/target" --exclude="$(basename "$CRATE")/vendor/*/target" \
    --transform "s,^$(basename "$CRATE"),atmos-render," "$(basename "$CRATE")"
xz -T1 -6 -c "$SOURCE_TAR" > "$OUT/atmos-render-source.tar.xz"
sed -e "s/@FFMPEG_COMMIT@/$FFMPEG_COMMIT/" -e "s/@EMSCRIPTEN_VERSION@/$EMSCRIPTEN_VERSION/" \
    "$HERE/SOURCE.txt" > "$OUT/AIOSTREAMS-SOURCE.txt"
ls -l "$OUT"
