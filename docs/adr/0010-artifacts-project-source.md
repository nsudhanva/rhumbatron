# ADR 0010: Artifacts as Project source, seeded from fixtures

- Status: Accepted
- Date: 2026-10-08
- Decider: Project owner (cost cap: Linear HOM-192)

## Context

Agents need a real codebase (AGENTS.md sections 29 and 54). Artifacts is Workers Paid only and
in open beta; billing starts 2026-10-14 with 10,000 operations and 1 GB-month included. The owner
approved Artifacts within the included allowance.

## Decision

- Terraform binds `ARTIFACTS` (namespace `rhumbatron-projects-<env>`) on the integration Worker.
  Provider 5.27 has no namespace resource, and namespaces are created on first use, so no
  adapter is needed. Repos are runtime data (section 2.1): one per Project, named by Project ID.
- Creating a Project queues `project.provision` on `rhumbatron-integration`. The integration
  Worker creates the repo, seeds a template commit with isomorphic-git over an in-memory file
  system (the binding has no write API; Artifacts accepts git push protocol v1), and calls
  `ProjectRootDO.assignSource`, which sets the canonical ref and tree for generation 0 once and
  records `artifact.promoted` in the same transaction.
- Templates live in `fixtures/` and are embedded by `scripts/build-fixtures.ts` into
  `*.fixture.gen.ts`. The private GitHub repo cannot be used, because Artifacts import accepts
  only public URLs. `POST /v1/projects/:id/provision` seeds an existing Project without source.
- Push tokens are minted per call with a 10-minute TTL and never stored or logged.

## Cost

A seed is a handful of operations; forks, clones, and pushes per Change are tens. Stay far below
10,000 operations per month. Revisit before any automation that clones per wake.
