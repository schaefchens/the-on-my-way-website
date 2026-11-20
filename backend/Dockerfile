# syntax=docker/dockerfile:1.7
#
# On My Way backend: wa-helper (Go) + Node orchestrator + the built public site, one image.
# Build context is the REPOSITORY ROOT (the image needs packages/, frontend/ and the lockfile):
#
#   docker build -f backend/Dockerfile -t omw-backend .                       # this machine's arch
#   docker buildx build -f backend/Dockerfile --platform linux/amd64 -t omw-backend .  # other arch (QEMU)
#   docker build -f backend/Dockerfile --target demo -t omw-backend:demo .     # + fixtures (WA_MODE=fixture)
#   docker build -f backend/Dockerfile --target test -t omw-backend:test .     # unit tests on Node 24
#
# Stages: go (wa-helper, CGO_ENABLED=0, cross-compiled) · prod-deps (production node_modules only)
# · web (full install; builds contracts, site, backend) · fixtures · test · runtime · demo.
# Measured 2026-11 on an M-series Mac (Docker Desktop): arm64 cold build ~100 s, ~770 MB image
# (ffmpeg + its libraries ~400 MB); amd64 under QEMU ~150 s. scripts/docker-e2e.sh runs the image.
# The runtime keeps the repository layout (/app/backend, /app/packages/contracts,
# /app/frontend/site/dist), so every default path in backend/src/config.ts and paths.ts applies.

ARG NODE_IMAGE=node:24-bookworm-slim
ARG GO_IMAGE=golang:1.26-bookworm

# ------------------------------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS go
ARG TARGETOS
ARG TARGETARCH
ENV CGO_ENABLED=0 GOFLAGS=-buildvcs=false GOTOOLCHAIN=local
WORKDIR /src
COPY backend/wa-helper/go.mod backend/wa-helper/go.sum ./
RUN --mount=type=cache,id=omw-gomod,target=/go/pkg/mod go mod download && go mod verify
COPY backend/wa-helper/ ./
RUN --mount=type=cache,id=omw-gomod,target=/go/pkg/mod --mount=type=cache,id=omw-gobuild,target=/root/.cache/go-build \
    GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -ldflags='-s -w' -o /out/wa-helper .

# ------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS pnpm-base
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# pnpm version from package.json "packageManager" (corepack ships with Node 24).
RUN corepack enable pnpm
WORKDIR /app
# .npmrc keeps the pnpm store in /app/.cache (a build cache mount below).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/contracts/package.json packages/contracts/
COPY backend/package.json backend/
COPY frontend/shared/package.json frontend/shared/
COPY frontend/site/package.json frontend/site/
COPY frontend/admin/package.json frontend/admin/

# ------------------------------------------------------------------------------------------------
FROM pnpm-base AS prod-deps
RUN --mount=type=cache,id=omw-pnpm-store,target=/app/.cache/pnpm-store \
    pnpm install --frozen-lockfile --prod --filter "@omw/backend..."

# ------------------------------------------------------------------------------------------------
FROM pnpm-base AS web
RUN --mount=type=cache,id=omw-pnpm-store,target=/app/.cache/pnpm-store \
    pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/contracts/ packages/contracts/
COPY frontend/ frontend/
COPY backend/ backend/
RUN pnpm --filter @omw/contracts build \
 && pnpm --filter @omw/site build \
 && pnpm --filter @omw/backend build \
 && test -f frontend/site/dist/.vite/manifest.json \
 && test -f backend/dist/main.js

# ------------------------------------------------------------------------------------------------
# Synthetic fixtures for the demo image (fixtures/generate.ts needs ffmpeg with x264/x265/opus).
FROM web AS fixtures
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
COPY fixtures/generate.ts fixtures/tsconfig.json fixtures/
COPY fixtures/vectors/ fixtures/vectors/
RUN pnpm fixtures && test -f fixtures/generated/index.json

# ------------------------------------------------------------------------------------------------
# Contracts + backend unit tests on the image's Node version (24), Linux and the image's ffmpeg.
# Not part of any runtime image. Runs as root (tests write below /app/.cache/tmp):
#   docker build -f backend/Dockerfile --target test -t omw-backend:test . && docker run --rm omw-backend:test
# Left out here: test/generator/e2e.test.ts (needs Playwright's Chromium; scripts/docker-e2e.sh
# checks the image's generated site with Playwright on the host instead) and
# test/pipeline/edge-media.test.ts (builds its rotated input with `-display_rotation`, ffmpeg >= 6;
# Debian bookworm ships 5.1). --testTimeout: the in-process SSH server test needs > 5 s here.
# Scratch files go to /app/.cache: `docker run --rm --tmpfs /app/.cache:exec omw-backend:test`.
FROM fixtures AS test
# The contracts test compares the JSON Schema export with the committed api/schemas.
COPY api/schemas/ api/schemas/
CMD ["sh", "-c", "node --version && pnpm --filter @omw/contracts test && pnpm --filter @omw/backend exec vitest run --exclude test/generator/e2e.test.ts --exclude test/pipeline/edge-media.test.ts --testTimeout=30000"]

# ------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="omw-backend" \
      org.opencontainers.image.description="On My Way backend: WhatsApp capture, media pipeline, static site generator, publisher" \
      omw.project="omw"
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Declared BELOW the ~400 MB apt layer: a build arg in scope is part of every following RUN's
# cache key, so each OMW_VERSION (0.1.0-docker, 0.1.0-demo, per release) would re-install ffmpeg.
ARG OMW_VERSION=0.1.0-docker
LABEL org.opencontainers.image.version="${OMW_VERSION}"
ENV NODE_ENV=production \
    OMW_VERSION=${OMW_VERSION} \
    DATA_DIR=/data \
    CONTROL_HOST=0.0.0.0 \
    CONTROL_PORT=8787
WORKDIR /app
# Production dependencies (pnpm isolated layout: relative symlinks into node_modules/.pnpm).
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/backend/node_modules ./backend/node_modules
COPY --from=prod-deps /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY package.json ./
COPY packages/contracts/package.json ./packages/contracts/
COPY --from=web /app/packages/contracts/dist ./packages/contracts/dist
COPY backend/package.json ./backend/
COPY --from=web /app/backend/dist ./backend/dist
# Control UI assets are served from backend/src/ui/static (no build step).
COPY backend/src/ui/static ./backend/src/ui/static
COPY --from=web /app/frontend/site/dist ./frontend/site/dist
COPY --from=go /out/wa-helper ./backend/wa-helper/bin/wa-helper
# `docker compose exec backend backend status`
RUN printf '#!/bin/sh\nexec node /app/backend/dist/cli.js "$@"\n' > /usr/local/bin/backend \
 && chmod 0755 /usr/local/bin/backend \
 && mkdir -p /data /app/backend/data/archive /app/backend/data/out /app/backend/data/config /app/backend/data/media \
 && chown -R node:node /data /app/backend/data
USER node
# Databases, WhatsApp session and inbox (WAL: keep this on a real volume, not a bind mount).
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.CONTROL_PORT||8787)+'/healthz',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# tini as subreaper: works as PID 1 (docker run) and under compose's `init: true`.
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
CMD ["node", "/app/backend/dist/main.js"]

# ------------------------------------------------------------------------------------------------
# Demo image: runtime + the synthetic fixtures (WA_MODE=fixture replays them, no phone needed).
FROM runtime AS demo
COPY --from=fixtures --chown=node:node /app/fixtures/generated /app/fixtures/generated

# Default target.
FROM runtime
