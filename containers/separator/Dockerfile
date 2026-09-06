FROM node:22-bookworm-slim

ARG DEMUCS_VERSION=4.0.1
ARG MODEL_FILE=955717e8-8726e21a.th
ARG MODEL_HASH=8726e21a
ARG MODEL_URL=https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg python3 python3-pip python3-venv \
  && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/venv \
  && /opt/venv/bin/pip install --no-cache-dir "demucs==${DEMUCS_VERSION}"

RUN mkdir -p /opt/demucs-models \
  && curl -fsSL "${MODEL_URL}" -o "/opt/demucs-models/${MODEL_FILE}" \
  && test "$(sha256sum "/opt/demucs-models/${MODEL_FILE}" | cut -c1-8)" = "${MODEL_HASH}"

ENV PATH="/opt/venv/bin:${PATH}" \
    DEMUCS_MODEL_ID=htdemucs \
    DEMUCS_MODEL_SIGNATURE=955717e8 \
    DEMUCS_MODEL_DIGEST=sha256:8726e21a \
    DEMUCS_MODEL_REPO=/opt/demucs-models \
    PORT=8080

WORKDIR /app
COPY server.mjs ./server.mjs

EXPOSE 8080
CMD ["node", "server.mjs"]
