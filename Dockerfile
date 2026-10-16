# ── Stage 1: Dependencies ──────────────────────────────────────────────────────
# Debian, not Alpine — the one deliberate divergence from the `learn` image.
# Local embeddings (added in milestone 2) run on onnxruntime-node, whose
# prebuilt binaries are glibc-only and fail on musl. Choosing the base now
# avoids a painful swap once the model is wired in.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ── Stage 2: Builder ───────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── Stage 3: Runner ────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

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
