# Module: code-storage

Status: placeholder. It has no resources.

- Artifacts: provider 5.27 has no Artifacts resource. The namespace `rhumbatron-projects-<env>` is
  created on first use through the `ARTIFACTS` Worker binding (ADR 0010), so no adapter exists.
- Workers Builds: provider 5.27 has no Builds resource, and the Builds API rejects an Artifacts
  connection (ADR 0018). The connection is a one-time dashboard step.
