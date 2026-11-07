# atmos-render: Dolby Atmos for Headphones' renderer, for binaural conversions.
FROM rust:1-bookworm AS atmos-render
WORKDIR /src
COPY atmos-render ./
RUN cargo build --release --locked && strip target/release/atmos-render

FROM node:24-bookworm-slim
# jellyfin-ffmpeg, Jellyfin's FFmpeg build (CUDA/NVENC, VA-API, QSV, OpenCL and Vulkan, with
# tonemap_cuda/tonemap_opencl and libplacebo), from Jellyfin's repository.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://repo.jellyfin.org/jellyfin_team.gpg.key | gpg --dearmor -o /etc/apt/keyrings/jellyfin.gpg \
 && printf 'Types: deb\nURIs: https://repo.jellyfin.org/debian\nSuites: bookworm\nComponents: main\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/jellyfin.gpg\n' "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/jellyfin.sources \
 && apt-get update && apt-get install -y --no-install-recommends jellyfin-ffmpeg8 mesa-va-drivers fonts-dejavu-core \
 && if [ "$(dpkg --print-architecture)" = amd64 ]; then apt-get install -y --no-install-recommends intel-media-va-driver; fi \
 && ln -s /usr/lib/jellyfin-ffmpeg/ffmpeg /usr/local/bin/ffmpeg \
 && ln -s /usr/lib/jellyfin-ffmpeg/ffprobe /usr/local/bin/ffprobe \
 && apt-get purge -y curl gnupg && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=atmos-render /src/target/release/atmos-render /usr/local/bin/atmos-render
COPY transcoder/server.mjs transcoder/media.mjs ./
RUN mkdir /cache && chown node:node /cache
USER node
ENV PORT=3100 CACHE_DIR=/cache
EXPOSE 3100
CMD ["node", "server.mjs"]
