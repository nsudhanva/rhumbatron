# Core: API, coordinator actors, agents, integration, event router and indexer in one Bun process.
# Build from the repository root:  docker build -f services/core/Dockerfile .
# Bun 1.4: Playwright connect() to the browser service hangs on Bun 1.3 (its bundled ws upgrade).
FROM oven/bun:1.4.4
WORKDIR /repo
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts \
      --filter @rhumbatron/platform \
      --filter @rhumbatron/api \
      --filter @rhumbatron/coordinator \
      --filter @rhumbatron/agents \
      --filter @rhumbatron/integration \
      --filter @rhumbatron/event-router \
      --filter @rhumbatron/indexer \
  && mkdir -p /data && chown -R bun:bun /data
USER bun
ENV DATA_DIR=/data NODE_ENV=production
VOLUME /data
EXPOSE 8787 8790
CMD ["bun", "--preload", "./packages/platform/src/preload.ts", "services/core/src/main.ts"]
