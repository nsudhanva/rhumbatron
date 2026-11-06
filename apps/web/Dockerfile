# check=skip=SecretsUsedInArgOrEnv
# (VITE_CLERK_PUBLISHABLE_KEY is a public value, not a secret.)
# rhumbatron-web: TanStack Start app served by Bun (serve.ts).
# Build from the repository root: docker build -f apps/web/Dockerfile .
# Ignore rules: apps/web/Dockerfile.dockerignore.

FROM oven/bun:1.3.14-debian AS build
WORKDIR /repo

# Public Clerk values. Vite inlines VITE_* values into the client bundle at build time.
ARG VITE_CLERK_PUBLISHABLE_KEY
ARG VITE_CLERK_SIGN_IN_URL=/sign-in
ARG VITE_CLERK_SIGN_UP_URL=/sign-up
ARG VITE_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/
ARG VITE_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/

COPY . .
# Only the web app and its workspace dependencies. Scripts stay off: `prepare` installs Git hooks.
RUN bun install --frozen-lockfile --ignore-scripts --filter @rhumbatron/web
RUN test -n "$VITE_CLERK_PUBLISHABLE_KEY" || (echo "VITE_CLERK_PUBLISHABLE_KEY build arg is required" >&2; exit 1)
RUN cd apps/web && bun run build

FROM oven/bun:1.3.14-debian
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
# The server bundle is self-contained (vite.config.ts `ssr.noExternal`): no node_modules.
COPY --from=build --chown=bun:bun /repo/apps/web/dist ./dist
COPY --from=build --chown=bun:bun /repo/apps/web/serve.ts ./serve.ts
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT ?? 3000) + '/robots.txt').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "serve.ts"]
