# Protocols

The Zod schemas in `packages/protocol/src` are the protocol source of truth. No separate protocol
documents exist yet.

| File | Content |
|---|---|
| `event.ts` | Event envelope and Event types (AGENTS.md section 17). |
| `command.ts` | Queue command envelope (section 20). |
| `project.ts` | Project, Change, policies, and create requests. |
| `work-graph.ts` | Work Graph and Task. |
| `conflict.ts` | Intent, Challenge, and conflict reports (sections 26 and 32). |
| `candidate.ts` | Candidate, Evidence, Verification Plan, approval, and promotion (sections 34 and 36). |
| `workspace.ts`, `context.ts` | Workspace manifest and Context Packet (section 27). |
| `release.ts`, `api.ts` | Release records, API errors, and health responses. |
