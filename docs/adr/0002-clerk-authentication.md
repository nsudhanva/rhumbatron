# ADR 0002: Clerk for user authentication

## Context

Rhumbatron needs user sign-in for `rhumbatron.com`. Cloudflare Access protects internal operator
pages. It has no product sign-up flow for end users.

## Decision

Use Clerk (application `Rhumbatron`) with `@clerk/tanstack-react-start` in `apps/web`. Prod uses
the Clerk production instance on `rhumbatron.com`.

- `src/start.ts` runs `clerkMiddleware()` after the server-function CSRF middleware.
- `ClerkProvider` wraps the body contents in `src/routes/__root.tsx`.
- `/sign-in` and `/sign-up` host the Clerk components.
- For a visitor that the server saw as signed out, `src/client.tsx` holds the Clerk browser script
  (`src/lib/clerk-deferral.ts`). The script loads on the first pointer, touch, key, or focus event,
  or at the Clerk 15 s script timeout. Clerk loads at once on `/sign-in` and `/sign-up`, with a
  non-zero `__client_uat` cookie, or with a `__clerk` URL parameter. Server auth does not change.
- The API Worker verifies tokens with `@clerk/backend` `verifyToken` (`workers/api/src/auth.ts`).
  It checks `azp` against `CLERK_AUTHORIZED_PARTIES` (prod: `https://rhumbatron.com`). A token
  without `azp` passes only when `CLERK_ALLOW_MISSING_AZP` is `"true"`. Prod sets `"false"`.
- `envs/prod` manages the Clerk DNS records as DNS-only CNAMEs (`var.clerk_dns_records`). The
  `clerk_production_instance` check warns when the publishable key does not start with `pk_live_`.

## Secrets

- Local: `apps/web/.env.local`, written by `clerk init`. Git ignores it.
- Remote: Terraform sets `CLERK_SECRET_KEY` as a `secret_text` binding on the API and web Workers.
  `scripts/tf.ts` loads the value from the Keychain item `rhumbatron-clerk-secret-key-prod` into a
  `TF_VAR_` variable. The value never appears in Terraform source.
- The publishable key is public. The Keychain item `rhumbatron-clerk-publishable-key-prod` holds it.
  The build inlines it. The prod web Worker also has it as the `plain_text` binding
  `VITE_CLERK_PUBLISHABLE_KEY`, because Clerk reads `process.env` first and `nodejs_compat` fills
  `process.env` from bindings.

## Consequences

- Authorization stays in Rhumbatron code (AGENTS.md section 40). Clerk only proves identity.
- Every `/v1` route of the API Worker runs `requireAuth`, except `/v1/version`. `/health` and
  `/v1/version` return only the service name and environment.

## Diagram

One API call from a page. The browser never calls the API Worker directly. Server functions use
the `API` service binding.

```mermaid
sequenceDiagram
  participant B as Browser
  participant C as Clerk
  participant W as Web Worker (apps/web)
  participant A as API Worker (requireAuth)
  participant D as D1
  B->>C: Sign in on /sign-in (Clerk components)
  C-->>B: Session
  B->>W: Request (clerkMiddleware after CSRF middleware)
  W->>W: Server function calls auth().getToken()
  W->>A: env.API.fetch with Authorization Bearer token
  A->>A: verifyToken(CLERK_SECRET_KEY), then azp check (CLERK_AUTHORIZED_PARTIES)
  A->>D: ensureIdentity (users, organizations, memberships)
  A->>D: projectRole (organization membership or project_members row)
  A-->>W: JSON response, or 401 on any failed check
```
