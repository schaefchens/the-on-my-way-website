# syntax=docker/dockerfile:1.7
#
# On My Way backend: wa-helper (Go) + Node orchestrator + the built public site, one image.
# Base: Debian 13 "trixie" (node:24-trixie-slim with Debian's ffmpeg 7.1; Go stage golang:1.26-trixie).
# Build context is the REPOSITORY ROOT (the image needs packages/, frontend/ and the lockfile).
# Build with the project's own buildx builder: Docker Desktop's disk is shared with other projects,
# and a dedicated builder keeps this cache separate (`docker buildx prune --builder omw-builder`).
#
#   docker buildx create --name omw-builder --driver docker-container      # once
#   B="docker buildx build --builder omw-builder --load -f backend/Dockerfile"
#   $B -t omw-backend .                                    # this machine's arch
#   $B --platform linux/amd64 -t omw-backend .             # other arch (QEMU)
#   $B --target demo -t omw-backend:demo .                 # + fixtures (WA_MODE=fixture)
#   $B --target test -t omw-backend:test .                 # unit tests on Node 24
#
# Stages: go (wa-helper, CGO_ENABLED=0, cross-compiled) · prod-deps (production node_modules only)
# · web (full install; builds contracts, site + gate bundle, backend) · fixtures · test · runtime · demo.
# The web stage fails when the gate bundle (frontend/site/dist/gate/.vite/manifest.json, entry
# src/gate/main.ts) is missing: ACCESS_MODE=gate cannot generate without it (spec-wave5 §6.1).
# Measured 2026-11-20 on an M-series Mac (Docker Desktop, arm64): ~785 MB image (ffmpeg 7.1 + its
# libraries ~415 MB); a cold test + runtime build took ~7 min, mostly downloads. Disk: a cold build
# of both targets peaks at ~6-7 GB in Docker's VM (omw-builder cache ~4 GB + the loaded image);
# `docker buildx prune --builder omw-builder --reserved-space 2gb -f` trims the cache afterwards.
# amd64 under QEMU was ~150 s on bookworm (not re-measured on trixie). scripts/docker-e2e.sh runs it.
# The runtime keeps the repository layout (/app/backend, /app/packages/contracts,
# /app/frontend/site/dist), so every default path in backend/src/config.ts and paths.ts applies.

ARG NODE_IMAGE=node:24-trixie-slim
ARG GO_IMAGE=golang:1.26-trixie

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
 && test -f frontend/site/dist/gate/.vite/manifest.json \
 && test -f backend/dist/main.js

# ------------------------------------------------------------------------------------------------
# Synthetic fixtures for the demo image (fixtures/generate.ts needs ffmpeg with x264/x265/opus).
FROM web AS fixtures
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
COPY fixtures/generate.ts fixtures/vectors-w5.ts fixtures/tsconfig.json fixtures/
COPY fixtures/vectors/ fixtures/vectors/
RUN pnpm fixtures && test -f fixtures/generated/index.json

# ------------------------------------------------------------------------------------------------
# Contracts + backend unit tests on the image's Node version (24), Linux and the image's ffmpeg.
# Not part of any runtime image. Runs as root (tests write below /app/.cache/tmp):
#   $B --target test -t omw-backend:test . && docker run --rm omw-backend:test     ($B: see the top)
# The test image is ~1.2 GB; `docker rmi omw-backend:test` afterwards.
# Left out here: test/generator/e2e.test.ts (needs Playwright's Chromium; scripts/docker-e2e.sh
# checks the image's generated site with Playwright on the host instead), test/scripts (tests
# scripts/deploy-api.ts against api/src, neither is in the image) and test/gate (the Apache suite has
# its own config and needs httpd; vitest.config.ts excludes it). The edge-media test runs:
# trixie's ffmpeg 7.1 has `-display_rotation` (ffmpeg >= 6) for its rotated input.
# --testTimeout: the in-process SSH server test needs > 5 s here.
# Scratch files go to /app/.cache: `docker run --rm --tmpfs /app/.cache:exec omw-backend:test`.
FROM fixtures AS test
# The contracts test compares the JSON Schema export with the committed api/schemas.
COPY api/schemas/ api/schemas/
CMD ["sh", "-c", "node --version && ffmpeg -version | head -n 1 && pnpm --filter @omw/contracts test && pnpm --filter @omw/backend exec vitest run --exclude test/generator/e2e.test.ts --exclude 'test/scripts/**' --testTimeout=30000"]

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
