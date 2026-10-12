# coding-agent container

Rhumbatron does not use this directory. The Sandbox runs the prebuilt public image `docker.io/cloudflare/sandbox:0.12.6`
(Bun and Git). `local.sandbox_worker` in `infrastructure/terraform/envs/prod/main.tf` sets the image
([ADR 0011](../../docs/adr/0011-sandbox-workspaces.md), [ADR 0012](../../docs/adr/0012-sandbox-worker.md)).
Add a custom image here only when a target Project needs a tool that image does not have.

Do not add Terraform, Cloudflare, or deployment credentials to this image.
