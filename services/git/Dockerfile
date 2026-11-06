FROM oven/bun:1.3.14-debian

# git for storage and smart HTTP, tini to reap Git child processes, CA roots for `import`.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git tini ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json client.ts ./
COPY src ./src

RUN mkdir -p /srv/git && chown bun:bun /srv/git
USER bun

ENV GIT_ROOT=/srv/git \
  PORT=8080 \
  GIT_PUBLIC_URL=http://git:8080 \
  GIT_NAMESPACE=rhumbatron
VOLUME /srv/git
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:8080/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "src/server.ts"]
