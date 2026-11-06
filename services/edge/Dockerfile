# Edge: Caddy with the docs site built in. Build from the repository root.
FROM oven/bun:1.3.14 AS docs
WORKDIR /repo
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts --filter @rhumbatron/docs \
  && cd apps/docs && bun run build

FROM caddy:2.11.7-alpine
COPY services/edge/Caddyfile /etc/caddy/Caddyfile
COPY --from=docs /repo/apps/docs/dist /srv/docs
