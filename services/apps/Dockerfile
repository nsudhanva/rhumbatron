# Apps host: workers/apps on self-hosted workerd (services/apps/README.md).
# Build from the repository root:  docker build -f services/apps/Dockerfile .

FROM oven/bun:1.3.14 AS bundle
WORKDIR /repo
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts --filter @rhumbatron/apps \
  && bun services/apps/build.ts /out

# workerd from npm, pinned to the Worker's compatibility date (2026-10-08).
FROM oven/bun:1.3.14 AS workerd
WORKDIR /w
RUN echo '{"name":"w","private":true}' > package.json \
  && bun add workerd@1.20261008.1 \
  && cp node_modules/@cloudflare/workerd-linux-*/bin/workerd /workerd \
  && /workerd --version

FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --uid 10001 --create-home workerd \
  && mkdir -p /data/do && chown -R workerd /data
COPY --from=workerd /workerd /usr/local/bin/workerd
WORKDIR /srv
COPY services/apps/config.capnp ./config.capnp
COPY --from=bundle /out ./dist
ENV APPS_DOMAIN=rhumbatron.localhost ENVIRONMENT=local
USER workerd
VOLUME /data
EXPOSE 8788 8789
# --experimental: the workerLoader binding needs it.
CMD ["workerd", "serve", "config.capnp", "--experimental"]
