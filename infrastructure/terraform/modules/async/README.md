# Module: async

Owns the six Queues `rhumbatron-<purpose>-<env>`: `agent-wakeups`, `integration`,
`verification`, `indexing`, `release`, `dead-letter`. One Queue per purpose, never per Agent or
Project.

| Input | Default | Meaning |
|---|---|---|
| `account_id` | - | Cloudflare account ID. |
| `environment` | - | `dev` or `prod`. |
| `message_retention_seconds` | `86400` | Retention of an unconsumed message. |

Output: `queues`, a map from purpose to `{ name, id }`.

Not in this module:

- Queue consumers (`cloudflare_queue_consumer`) are in each env root, next to their Workers.
- Workflows (`cloudflare_workflow`) are in each env root.
- K2 streams and subscriptions use a temporary adapter in each env root (ADR 0006). Provider 5.27
  has no K2 resource.
