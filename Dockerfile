# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# Marshal — fraud-investigation console (Hono API + static SPA on one origin).
# There is NO build step: the server runs the TypeScript directly via tsx and
# serves ./public. So this is a single, lean image — install deps, copy source,
# run `pnpm start` (= tsx src/server/app.ts) on :8000.
#
# Data provisioning (provision / restore:replay) is intentionally NOT run here —
# it's a one-off job against Atlas driven by the deploy wrapper, so the image
# stays a pure runtime artifact.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# pnpm via corepack (repo uses pnpm). wget (busybox) is already present for the healthcheck.
RUN corepack enable

# Deps first (cached on lockfile change). tsx/typescript are dev deps the runtime needs,
# so install the full set rather than --prod.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# App source (server, public assets, scripts, and the committed demo recording in data/replay).
COPY . .

# Run as a non-root user.
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

ENV PORT=8000
EXPOSE 8000

# Liveness: the server's public /api/health.
HEALTHCHECK --interval=30s --timeout=4s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" || exit 1

CMD ["pnpm", "start"]
