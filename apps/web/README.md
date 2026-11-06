# @rhumbatron/web

The Rhumbatron web app: TanStack Start, React, and Vite, served by Bun.
In the Compose stack it runs behind Caddy at `https://rhumbatron.localhost`.

## How it runs

- `vite build` writes the client files to `dist/client` and one self-contained server bundle to `dist/server/server.js` (`vite.config.ts`: `ssr.noExternal`, Bun resolve conditions).
- `serve.ts` is the production server. It serves `dist/client` as static files and sends every other request to the TanStack Start server entry (`src/server.ts`).
- `/assets/*` files are fingerprinted and cached as immutable for one year. `/favicon.svg` is cached for one day.
- `src/server.ts` redirects `www.` hosts to the apex and rewrites each HTML page with Bun's `HTMLRewriter`, so the client entry starts after the first contentful paint.
- Server functions and server routes call the core API through `apiFetch` (`src/lib/server-env.ts`). Request code builds URLs on `https://api.internal`; `apiFetch` sends them to `API_INTERNAL_URL` with the Bearer token and all other headers. An unreachable API answers 502.
- The browser opens the live socket at `/live/projects/:projectId` on the same origin. Caddy sends that path to the core API, which authenticates the Clerk `__session` cookie. The web server has no live route.
- `serve.ts` takes the scheme from `X-Forwarded-Proto`, so the CSRF middleware and Clerk see the public `https://` origin behind Caddy.

## Environment

| Variable | When | Purpose |
|---|---|---|
| `VITE_CLERK_PUBLISHABLE_KEY` | Build (Docker build arg) | Clerk publishable key, inlined into the client bundle. Required. |
| `VITE_CLERK_SIGN_IN_URL`, `VITE_CLERK_SIGN_UP_URL` | Build | Clerk sign-in and sign-up paths. Default `/sign-in`, `/sign-up`. |
| `VITE_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL`, `VITE_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL` | Build | Where Clerk goes after sign-in or sign-up. Default `/`. |
| `CLERK_SECRET_KEY` | Runtime | Clerk secret key. Never a build arg; never in the image. |
| `API_INTERNAL_URL` | Runtime | Core API origin. Default `http://core:8787`. |
| `PORT`, `HOST` | Runtime | Listen address. Default `3000` and `0.0.0.0`. |
| `ENVIRONMENT`, `SERVICE_NAME` | Runtime | Shown in the status bar. Default `local` and `rhumbatron-web`. |

Clerk development keys work with the host `rhumbatron.localhost`: the Clerk handshake redirects back to `https://rhumbatron.localhost/` and sets the session cookies on that host.

## Local development

```sh
cp apps/web/.env.example apps/web/.env.local   # add the Clerk development keys
cd apps/web
bun run dev                                    # bun --bun vite dev, on localhost:5173
```

`bun run build` then `bun run start` runs the production server on port 3000.

## Container

Build from the repository root. The image needs the workspace packages.

```sh
docker build -f apps/web/Dockerfile -t rhumbatron-web \
  --build-arg VITE_CLERK_PUBLISHABLE_KEY=pk_test_... .
docker run --rm -p 3000:3000 \
  -e CLERK_SECRET_KEY=sk_test_... \
  -e API_INTERNAL_URL=http://core:8787 \
  rhumbatron-web
```

The image is `oven/bun:1.3.14-debian`. It holds only `dist/` and `serve.ts`, runs as the `bun` user on port 3000, and has a health check on `/robots.txt`. `apps/web/Dockerfile.dockerignore` keeps `.env*` files, `node_modules`, and build output out of the build context.
