FROM node:24-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    TRANSFORMERS_CACHE=/app/.cache \
    HF_HOME=/app/.cache \
    XDG_CACHE_HOME=/app/.cache \
    npm_config_update_notifier=false

RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY sentences.mjs ./
COPY kokoro-cpu-bench ./kokoro-cpu-bench

RUN mkdir -p /app/results /app/samples /app/.cache

ENTRYPOINT ["node", "kokoro-cpu-bench/bench.mjs"]
