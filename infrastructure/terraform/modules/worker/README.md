# Module: worker

Owns one Worker: metadata, one version per bundle hash, a 100 percent deployment, and custom domains.

Inputs come from `bun run cf:bundle`, which writes `dist/bundles/manifest.json` with module paths
and a content hash for each Worker. Build bundles before `terraform plan`.

Binding names must match the Worker's `wrangler.jsonc`.
