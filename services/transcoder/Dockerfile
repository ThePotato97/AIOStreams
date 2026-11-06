FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates mesa-va-drivers fonts-dejavu-core && if [ "$(dpkg --print-architecture)" = amd64 ]; then apt-get install -y --no-install-recommends intel-media-va-driver; fi && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server.mjs media.mjs ./
RUN mkdir /cache && chown node:node /cache
USER node
ENV PORT=3100 CACHE_DIR=/cache
EXPOSE 3100
CMD ["node", "server.mjs"]
