/**
 * One-time setup for the public docs site. Run it again at any time: each step checks first.
 *
 *   bun scripts/setup-docs-publishing.ts
 *
 * Needs the `cf` CLI logged in to the Cloudflare account and the `gh` CLI logged in to GitHub.
 *
 * 1. www.rhumbatron.com: a proxied DNS record and a zone redirect rule that sends every request
 *    to https://rhumbatron.com with the same path and query (301).
 * 2. GitHub Actions: a Cloudflare API token that can only deploy Workers on this account and
 *    manage Worker routes and DNS on rhumbatron.com. The token goes from `cf` to `gh secret set`
 *    through a pipe and is never printed. The repository variable CLOUDFLARE_ACCOUNT_ID turns on
 *    the `docs` workflow.
 * 3. Starts the `docs` workflow once.
 */
import { $ } from "bun";

const DOMAIN = "rhumbatron.com";
const WWW = `www.${DOMAIN}`;
const TOKEN_NAME = "rhumbatron-docs GitHub Actions deploy";
const RULE_REF = "www_to_apex";

/** Cloudflare permission groups (cf accounts tokens permission-groups list). */
const PERMISSIONS = {
  workersScriptsWrite: "e086da7e2179491d91ee5f35b3ca210a",
  accountSettingsRead: "c1fde68c7bcc44588cbb6ddbc16d6480",
  workersRoutesWrite: "28f4b596e7d643029c524985477ae49a",
  dnsWrite: "4755a26eedb94da69e1066d98aa820be",
  zoneRead: "c8fed203ed3043cba015a93ad1616f1f",
};

type Zone = { id: string; name: string; account: { id: string } };
type DnsRecord = { name: string; type: string };
type Rule = { ref?: string; [key: string]: unknown };
type Token = { id: string; name: string };

const zones = (await $`cf zones list`.quiet().json()) as Zone[];
const zone = zones.find((z) => z.name === DOMAIN);
if (!zone) throw new Error(`The Cloudflare account has no zone ${DOMAIN}.`);
const accountId = zone.account.id;
const cfAccount = { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId };

// 1. www redirect.
const records = (await $`cf dns records list -z ${zone.id} --name ${WWW}`
  .quiet()
  .json()) as DnsRecord[];
if (records.length === 0) {
  const body = JSON.stringify({
    type: "CNAME",
    name: "www",
    content: DOMAIN,
    proxied: true,
    ttl: 1,
    comment: `The zone rule ${RULE_REF} redirects it to ${DOMAIN}`,
  });
  await $`cf dns records create -z ${zone.id} --body ${body}`.quiet();
  console.log(`Created the proxied DNS record ${WWW}.`);
} else {
  console.log(`The DNS record ${WWW} exists.`);
}

const phase = "http_request_dynamic_redirect";
const current = await $`cf rulesets account-rulesets phases get ${phase} -z ${zone.id}`
  .quiet()
  .nothrow();
const rules: Rule[] =
  current.exitCode === 0 ? ((current.json() as { rules?: Rule[] }).rules ?? []) : [];
if (rules.some((r) => r.ref === RULE_REF)) {
  console.log(`The redirect rule ${RULE_REF} exists.`);
} else {
  const rule = {
    ref: RULE_REF,
    description: `${WWW} to ${DOMAIN}`,
    expression: `(http.host eq "${WWW}")`,
    action: "redirect",
    action_parameters: {
      from_value: {
        status_code: 301,
        target_url: { expression: `concat("https://${DOMAIN}", http.request.uri.path)` },
        preserve_query_string: true,
      },
    },
  };
  const keep = rules.map(({ id, version, last_updated, ...r }) => r);
  const body = JSON.stringify({ rules: [...keep, rule] });
  await $`cf rulesets account-rulesets phases update ${phase} -z ${zone.id} --body ${body}`.quiet();
  console.log(`Created the redirect rule ${RULE_REF}.`);
}

// 2. Token for GitHub Actions.
const secrets = await $`gh secret list`.quiet().text();
const tokens = (await $`cf accounts tokens list`.env(cfAccount).quiet().json()) as Token[];
const existing = tokens.filter((t) => t.name === TOKEN_NAME);
if (existing.length > 0 && /^CLOUDFLARE_API_TOKEN\s/m.test(secrets)) {
  console.log("The deploy token and the GitHub secret exist.");
} else {
  for (const old of existing) {
    await $`cf accounts tokens delete ${old.id} --force`.env(cfAccount).quiet();
  }
  const policies = JSON.stringify([
    {
      effect: "allow",
      resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
      permission_groups: [
        { id: PERMISSIONS.workersScriptsWrite },
        { id: PERMISSIONS.accountSettingsRead },
      ],
    },
    {
      effect: "allow",
      resources: { [`com.cloudflare.api.account.zone.${zone.id}`]: "*" },
      permission_groups: [
        { id: PERMISSIONS.workersRoutesWrite },
        { id: PERMISSIONS.dnsWrite },
        { id: PERMISSIONS.zoneRead },
      ],
    },
  ]);
  const created = (await $`cf accounts tokens create --name ${TOKEN_NAME} --policies ${policies}`
    .env(cfAccount)
    .quiet()
    .json()) as { value: string };
  await $`gh secret set CLOUDFLARE_API_TOKEN < ${new Response(created.value)}`.quiet();
  console.log("Created the deploy token and stored it as the GitHub secret CLOUDFLARE_API_TOKEN.");
}
await $`gh variable set CLOUDFLARE_ACCOUNT_ID --body ${accountId}`.quiet();
console.log("Set the GitHub variable CLOUDFLARE_ACCOUNT_ID.");

// 3. First run.
await $`gh workflow run docs.yml --ref main`.quiet();
console.log("Started the docs workflow. Watch it with: gh run watch");
