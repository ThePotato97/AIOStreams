FROM node:24.18.1-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# atmos-render's audio decoder packages for the WebGPU player, and the corresponding source FFmpeg's
# LGPL asks for (services/atmos-render/package/build.sh). WebAssembly, the same on every platform, so
# built once, on the build machine's. Emscripten 4.0.13 (the engine's) comes from emsdk at that
# release's commit, which has native amd64 and arm64 toolchains (its Docker image is amd64 only).
FROM --platform=$BUILDPLATFORM node:24.18.1-bookworm AS atmos-packages
ARG EMSDK_COMMIT=404dc1ec13f64fce1af1eaf5c007e18212f63527
ENV RUSTUP_HOME=/rustup CARGO_HOME=/cargo
RUN git init -q /emsdk \
  && git -C /emsdk fetch -q --depth 1 https://github.com/emscripten-core/emsdk.git "$EMSDK_COMMIT" \
  && git -C /emsdk checkout -q FETCH_HEAD \
  && /emsdk/emsdk install 4.0.13 \
  && /emsdk/emsdk activate 4.0.13
ENV EMSDK=/emsdk EM_CONFIG=/emsdk/.emscripten PATH=/cargo/bin:/emsdk:/emsdk/upstream/emscripten:$PATH
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal \
    --default-toolchain 1.97.0 --target wasm32-unknown-unknown --target wasm32-unknown-emscripten
COPY services/atmos-render /atmos-render
RUN sh /atmos-render/package/build.sh /packages

# The WebGPU player the web app serves: its engine rebuilt from the pinned source with this fork's
# patch, with the packages above (packages/web/webgpu-player/build.mjs). Also built once. On the
# packages' stage, whose Rust (rustup) builds the patched Dolby Vision RPU parser with the crate's
# pinned toolchain.
FROM atmos-packages AS webgpu-player
WORKDIR /build
COPY pnpm-lock.yaml ./
COPY packages/web/webgpu-player ./packages/web/webgpu-player
COPY --from=atmos-packages /packages /atmos-packages
# The published package at the pinned version, which build.mjs checks against pnpm-lock.yaml.
# The Dolby Vision display management, from the private dovi-dm submodule when the build checked it
# out (CI does with the DOVI_DM_SSH_KEY secret); without it the player keeps the engine's tone map.
RUN npm pack --silent --pack-destination /tmp \
    "@aiostreams/webgpu-player@$(node -p "require('./packages/web/webgpu-player/engine.json').tag.slice(1)")" \
  && dm="" \
  && if [ -f packages/web/webgpu-player/dovi-dm/webgpu/build.sh ]; then \
       sh packages/web/webgpu-player/dovi-dm/webgpu/build.sh /dovi-dm && dm="--dm /dovi-dm"; \
     fi \
  && node packages/web/webgpu-player/build.mjs --packages /atmos-packages \
    --published /tmp/aiostreams-webgpu-player-*.tgz $dm

# The player alone. CI builds this target once and passes it to both platforms' builds as a named
# build context of the same name, which replaces this stage there; a plain `docker build` builds it.
FROM scratch AS webgpu-player-dist
COPY --from=webgpu-player /build/packages/web/webgpu-player/dist /

FROM base AS builder

WORKDIR /build

# Build toolchain for native addons that lack prebuilt binaries on this platform
# (e.g. yencode, used by the native usenet engine, has no linux/arm64 prebuild and
# must be compiled with node-gyp → needs Python + a C/C++ toolchain). These tools
# live only in the builder/runtime stages; the final distroless image just copies
# the already-compiled .node binaries, so it stays clean.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Copy LICENSE file.
COPY LICENSE ./

# Copy the relevant package.json and package-lock.json files.
COPY package*.json ./
COPY packages/server/package*.json ./packages/server/
COPY packages/core/package*.json ./packages/core/
COPY packages/frontend/package*.json ./packages/frontend/
COPY packages/ui/package*.json ./packages/ui/
COPY packages/web/package*.json ./packages/web/
COPY packages/crypto/package*.json ./packages/crypto/
COPY pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY pnpm-lock.yaml ./pnpm-lock.yaml
COPY patches ./patches

# Install dependencies.
RUN pnpm install --frozen-lockfile

# Copy source files.
COPY tsconfig.*json ./

COPY packages/server ./packages/server
COPY packages/core ./packages/core
COPY packages/frontend ./packages/frontend
COPY packages/ui ./packages/ui
COPY packages/web ./packages/web
COPY packages/crypto ./packages/crypto
COPY scripts ./scripts
COPY resources ./resources
COPY --from=webgpu-player-dist / ./packages/web/webgpu-player/dist


# Build the project.
RUN pnpm run build

# Remove development dependencies.
RUN rm -rf node_modules
RUN rm -rf packages/core/node_modules
RUN rm -rf packages/server/node_modules
RUN rm -rf packages/frontend/node_modules
RUN rm -rf packages/ui/node_modules
RUN rm -rf packages/web/node_modules

RUN pnpm install --prod --frozen-lockfile


FROM builder AS runtime
WORKDIR /runtime

# Copy the built files from the builder.
# The package.json files must be copied as well for NPM workspace symlinks between local packages to work.
COPY --from=builder /build/package*.json /build/LICENSE ./
COPY --from=builder /build/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder /build/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=builder /build/patches ./patches

COPY --from=builder /build/packages/core/package.*json ./packages/core/
COPY --from=builder /build/packages/server/package.*json ./packages/server/

# Loader + built binary; core's node_modules symlink into packages/ resolves it.
COPY --from=builder /build/packages/crypto ./packages/crypto

COPY --from=builder /build/packages/core/dist ./packages/core/dist
COPY --from=builder /build/packages/frontend/dist ./packages/frontend/dist
COPY --from=builder /build/packages/web/dist ./packages/web/dist
COPY --from=builder /build/packages/server/dist ./packages/server/dist
COPY --from=builder /build/packages/server/src/static ./packages/server/dist/static

COPY --from=builder /build/resources ./resources
COPY --from=builder /build/scripts ./scripts

COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/packages/core/node_modules ./packages/core/node_modules
COPY --from=builder /build/packages/server/node_modules ./packages/server/node_modules


FROM debian:12-slim AS mimalloc
RUN apt-get update \
  && apt-get install -y --no-install-recommends libmimalloc2.0 \
  && rm -rf /var/lib/apt/lists/* \
  && cp /usr/lib/*/libmimalloc.so.2 /usr/local/lib/libmimalloc.so.2

# zlib is linked statically: the runtime image has no libz.
FROM debian:12-slim AS ffprobe
ARG FFMPEG_VERSION=8.1.3
ARG FFMPEG_SHA256=7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl xz-utils gcc libc6-dev make zlib1g-dev \
  && rm -rf /var/lib/apt/lists/* \
  && rm /usr/lib/*/libz.so
WORKDIR /src
RUN curl -fsSL -o ffmpeg.tar.xz "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
  && echo "${FFMPEG_SHA256}  ffmpeg.tar.xz" | sha256sum -c - \
  && tar -xJf ffmpeg.tar.xz --strip-components=1 \
  && ./configure \
    --disable-everything --disable-autodetect --disable-doc --disable-debug \
    --disable-programs --enable-ffprobe \
    --disable-avdevice --disable-avfilter --disable-swscale --disable-swresample \
    --disable-x86asm --enable-zlib \
    --enable-protocol=file,http,tcp \
    --enable-demuxer=asf,avi,flv,matroska,mov,mpegps,mpegts,ogg \
    --enable-parser=aac,aac_latm,ac3,av1,dca,dvbsub,dvdsub,flac,h264,hevc,mlp,mpeg4video,mpegaudio,mpegvideo,opus,vc1,vorbis,vp8,vp9 \
    --enable-decoder=aac,aac_latm,ac3,alac,dca,eac3,flac,mlp,mp2,mp3,opus,truehd,vorbis,pcm_bluray,pcm_dvd,pcm_s16le,pcm_s24le,h264,hevc,mpeg2video,mpeg4,vc1,vp8,vp9,ass,ssa,subrip,srt,webvtt,movtext,pgssub,dvdsub,dvbsub \
  && make -j"$(nproc)" ffprobe \
  && strip ffprobe

FROM gcr.io/distroless/nodejs24-debian13 AS production

LABEL org.opencontainers.image.title="AIOStreams"
LABEL org.opencontainers.image.source="https://github.com/Viren070/AIOStreams"
LABEL org.opencontainers.image.description="AIOStreams consolidates multiple Stremio addons and debrid services - including its own suite of built-in addons - into a single, highly customisable super-addon."
LABEL org.opencontainers.image.licenses="AGPL-3.0-only"

WORKDIR /app

COPY --from=busybox:1.36.0-uclibc /bin/wget /bin/wget
COPY --from=busybox:1.36.0-uclibc /bin/sh /bin/sh
COPY --from=mimalloc /usr/local/lib/libmimalloc.so.2 /usr/local/lib/libmimalloc.so.2
ENV LD_PRELOAD=/usr/local/lib/libmimalloc.so.2
COPY --from=ffprobe /src/ffprobe /usr/local/bin/ffprobe
ENV NODE_OPTIONS="--max-semi-space-size=8 --expose-gc"
COPY --from=runtime /runtime /app

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["/nodejs/bin/node", "/app/scripts/healthcheck.js"]
EXPOSE ${PORT:-3000}

CMD ["/app/packages/server/dist/server.js"]