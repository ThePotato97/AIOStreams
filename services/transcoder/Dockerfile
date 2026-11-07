FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates mesa-va-drivers fonts-dejavu-core && if [ "$(dpkg --print-architecture)" = amd64 ]; then apt-get install -y --no-install-recommends intel-media-va-driver; fi && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# NVIDIA's runtime mounts its OpenCL library (driver capability "compute"),
# which the OpenCL loader finds through this entry: GPU tone mapping uses it.
RUN mkdir -p /etc/OpenCL/vendors && echo libnvidia-opencl.so.1 > /etc/OpenCL/vendors/nvidia.icd
COPY server.mjs media.mjs ./
RUN mkdir /cache && chown node:node /cache
USER node
ENV PORT=3100 CACHE_DIR=/cache
EXPOSE 3100
CMD ["node", "server.mjs"]
