# ── Stage 1: Dependencies ──────────────────────────────────────────────────────
# Debian, not Alpine — the one deliberate divergence from the `learn` image.
# Local embeddings run on onnxruntime-node, whose prebuilt binaries are
# glibc-only and fail on musl.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ── Stage 2: Model ─────────────────────────────────────────────────────────────
# Bake the embedding model into the image. Its own stage so that editing source
# does not re-download 90MB: this layer is keyed only on the lockfile and the
# bake script.
#
# Fetching at runtime instead would mean a 30s+ first MCP tool call — the one a
# connector is most likely to give up on — and a container that is simply
# broken whenever HuggingFace is unreachable.
FROM node:24-bookworm-slim AS model
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY scripts/bake-model.mjs ./scripts/bake-model.mjs
RUN node scripts/bake-model.mjs /app/models

# ── Stage 3: ONNX runtime, pruned ──────────────────────────────────────────────
# transformers.js reaches onnxruntime-node through a runtime `require`, which
# the standalone tracer cannot follow: it copies fragments of such a package
# and nothing of its dependencies, so the container starts cleanly and then
# dies on first inference with "Cannot find module". Copying the packages
# whole is the reliable fix.
#
# It happens in its OWN STAGE because a `COPY` followed by a `RUN rm` in the
# runner would leave the deleted files sitting in the earlier layer — present
# in the image, invisible in the filesystem, and paid for on every pull. Doing
# both here means the runner copies the already-pruned result.
FROM node:24-bookworm-slim AS onnx
COPY --from=deps /app/node_modules/onnxruntime-node /onnx/onnxruntime-node
COPY --from=deps /app/node_modules/onnxruntime-common /onnx/onnxruntime-common
# A Linux npm install fetches every platform's binaries plus the CUDA and
# TensorRT execution providers — hundreds of megabytes of GPU runtime this
# CPU-only service will never load.
RUN rm -rf /onnx/onnxruntime-node/bin/napi-v6/darwin \
           /onnx/onnxruntime-node/bin/napi-v6/win32 \
           /onnx/onnxruntime-node/bin/napi-v6/linux/arm64 \
           /onnx/onnxruntime-node/script && \
    rm -f  /onnx/onnxruntime-node/bin/napi-v6/linux/x64/*providers* && \
    du -sh /onnx

# ── Stage 4: Builder ───────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── Stage 5: Runner ────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# The pruned ONNX runtime from stage 3 — see the comment there for why these
# two packages are copied wholesale instead of being traced.
COPY --from=onnx /onnx/ ./node_modules/

# Read-only at runtime: embeddings.ts sets allowRemoteModels=false, so this is
# the only copy of the model the container will ever see. If it is missing or
# wrong, startup says so rather than quietly reaching for the network.
COPY --from=model --chown=nextjs:nodejs /app/models ./models
ENV MODEL_DIR=/app/models

# Exports and backups written by the app land here. Created in the IMAGE and
# chowned first: Docker seeds an empty named volume from the image's directory
# — contents, uid and mode — so if this path were absent or root-owned, the
# volume would mount root:root and uid 1001's first write would die with
# EACCES. (Same lesson the `learn` service documents for its SQLite volume.)
RUN mkdir -p /app/data && chown nextjs:nodejs /app/data
ENV DATA_DIR=/app/data

USER nextjs

EXPOSE 9999
ENV PORT=9999
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
