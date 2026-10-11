# Module: security

Owns zone settings only: one `cloudflare_zone_setting` per entry of `zone_settings`. Used by
`envs/global`, which sets `always_use_https`, `automatic_https_rewrites`, `min_tls_version`,
`tls_1_3`, and `ssl = "strict"`.

| Input | Meaning |
|---|---|
| `zone_id` | Zone ID (from `modules/dns`). |
| `zone_settings` | Map from setting ID to value. |

Output: `zone_settings`.

The module holds zone settings only. WAF, rate-limit, Access, and Turnstile rules belong in this
module when a public endpoint needs them (AGENTS.md section 40.4).
