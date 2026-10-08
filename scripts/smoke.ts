/**
 * Remote smoke check for a deployed environment. Read-only HTTP requests.
 * Usage: bun scripts/smoke.ts <dev|prod>
 */

const hosts: Record<string, { web: string; api: string }> = {
  dev: { web: "https://dev.rhumbatron.com", api: "https://api-dev.rhumbatron.com" },
  prod: { web: "https://rhumbatron.com", api: "https://api.rhumbatron.com" },
};

type Check = {
  name: string;
  url: string;
  status: number;
  contains?: string;
};

const env = process.argv[2] ?? "dev";
const target = hosts[env];
if (!target) {
  console.error(`Usage: bun scripts/smoke.ts <${Object.keys(hosts).join("|")}>`);
  process.exit(2);
}

const checks: Check[] = [
  {
    name: "api health",
    url: `${target.api}/health`,
    status: 200,
    contains: `"service":"rhumbatron-api-${env}"`,
  },
  { name: "api version", url: `${target.api}/v1/version`, status: 200 },
  { name: "api unknown route", url: `${target.api}/smoke-not-found`, status: 404 },
  { name: "web home", url: `${target.web}/`, status: 200, contains: `rhumbatron-web-${env}` },
  { name: "web sign-in", url: `${target.web}/sign-in`, status: 200 },
];

let failed = 0;
for (const check of checks) {
  try {
    const response = await fetch(check.url, { redirect: "manual" });
    const body = await response.text();
    const statusOk = response.status === check.status;
    const bodyOk = check.contains ? body.includes(check.contains) : true;
    const ok = statusOk && bodyOk;
    if (!ok) failed++;
    const detail = statusOk
      ? bodyOk
        ? ""
        : ` missing "${check.contains}"`
      : ` got ${response.status}`;
    console.log(`${ok ? "pass" : "FAIL"}  ${check.name}  ${check.url}${detail}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${check.name}  ${check.url}  ${String(error)}`);
  }
}

console.log(`\n${checks.length - failed}/${checks.length} checks passed for ${env}.`);
process.exit(failed === 0 ? 0 : 1);
