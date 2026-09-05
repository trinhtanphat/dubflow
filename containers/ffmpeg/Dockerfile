FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.mjs /app/server.mjs

ENV PORT=8080
EXPOSE 8080
CMD ["node", "/app/server.mjs"]
