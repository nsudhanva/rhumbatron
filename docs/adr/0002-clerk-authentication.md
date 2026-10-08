# ADR 0002: Clerk for user authentication

- Status: Accepted
- Date: 2026-10-08
- Decider: Project owner

## Context

Rhumbatron needs user sign-in for `rhumbatron.com`. Cloudflare Access protects internal operator
pages, but it is not a product sign-up flow for end users.

## Decision

Use Clerk (application `Rhumbatron`, `app_3KOhGuEyKohDT9Lzrb2NvUVQZP4`) with
`@clerk/tanstack-react-start` in `apps/web`.

- `src/start.ts` runs `clerkMiddleware()` after the server-function CSRF middleware.
- `ClerkProvider` wraps the body contents in `src/routes/__root.tsx`.
- `/sign-in` and `/sign-up` host the Clerk components.

## Secrets

- Local: `apps/web/.env.local`, written by `clerk init`, ignored by Git.
- Remote: `CLERK_SECRET_KEY` becomes a Worker `secret_text` binding in Terraform, with the value
  supplied through a `TF_VAR_` environment variable. It never appears in Terraform source.
- `VITE_CLERK_PUBLISHABLE_KEY` is public and is inlined at build time.

## Consequences

- Authorization stays in Rhumbatron code (AGENTS.md section 40). Clerk only proves identity.
- The production Clerk instance is not configured yet. Configure it before the prod environment.
