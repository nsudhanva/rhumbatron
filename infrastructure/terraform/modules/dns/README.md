# Module: dns

Reads the `rhumbatron.com` zone with a `cloudflare_zone` data source. Terraform never manages the
zone lifecycle, so no plan can delete the domain.

| Input | Meaning |
|---|---|
| `account_id` | Cloudflare account ID. |
| `zone_name` | Zone name (`rhumbatron.com`). |

Outputs: `zone_id`, `zone_name`.

This module manages no DNS records. Worker custom domains create their own records. The Clerk
CNAMEs are `cloudflare_dns_record.clerk` in `envs/prod` (ADR 0017).
