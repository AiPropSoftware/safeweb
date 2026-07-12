# SafeWeb accountability server — zero npm dependencies, so the image is tiny
# and there is no install step.
FROM node:22-alpine

WORKDIR /app
COPY . .

# Bake the full public blocklist into the image so a hosted server has broad
# coverage out of the box. Non-fatal if the network is unavailable at build time
# (the curated seed list is always present).
RUN node scripts/update-blocklist.js || echo "blocklist update skipped (offline build)"

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

# Run as a non-root user; /data is a writable volume for persistence.
RUN mkdir -p /data \
 && addgroup -S safeweb && adduser -S safeweb -G safeweb \
 && chown -R safeweb:safeweb /data /app
USER safeweb

EXPOSE 8080
VOLUME ["/data"]

# Basic liveness probe against the health endpoint.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/api/v1/health || exit 1

CMD ["node", "server/src/index.js"]
