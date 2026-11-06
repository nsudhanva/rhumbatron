/**
 * Trusts the local stack's certificate authority, so browsers accept https://rhumbatron.localhost
 * and every *.rhumbatron.localhost host without a warning.
 *
 * Caddy (the `edge` service) creates the CA on its first start and keeps it in the `caddy-data`
 * volume. This script copies the root certificate to `.local-ca.crt` and, on macOS, adds it to
 * your login keychain as a trusted root. macOS asks for your password once. Run it again only
 * after `docker compose down -v`, which deletes the CA.
 *
 * `--check` only reports whether the CA is trusted (`bun run stack:up` runs it last).
 *
 * Bun and Node scripts can use the same file: NODE_EXTRA_CA_CERTS=.local-ca.crt
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

const root = join(import.meta.dir, "..");
const checkOnly = process.argv.includes("--check");
const target = join(root, ".local-ca.crt");

await $`docker compose cp edge:/data/caddy/pki/authorities/local/root.crt ${target}`
  .cwd(root)
  .quiet();
console.log(`Copied the local CA to ${target}.`);

if (process.platform !== "darwin") {
  if (checkOnly) process.exit(0);
  console.log(
    "Add it to your system trust store, for example:\n  sudo cp .local-ca.crt /usr/local/share/ca-certificates/rhumbatron.crt && sudo update-ca-certificates",
  );
  process.exit(0);
}

const trusted = async () =>
  (await $`security verify-cert -c ${target} -p ssl`.quiet().nothrow()).exitCode === 0;

if (await trusted()) {
  console.log("The local CA is trusted. Open https://rhumbatron.localhost.");
  process.exit(0);
}
if (checkOnly) {
  console.log("Browsers do not trust the local CA yet. Run `bun run stack:trust` once.");
  process.exit(0);
}

const keychain = join(homedir(), "Library/Keychains/login.keychain-db");
console.log("Adding the local CA to your login keychain. macOS asks for your password.");
await $`security add-trusted-cert -r trustRoot -p ssl -k ${keychain} ${target}`;
if (!(await trusted())) {
  console.error(
    "macOS did not accept the trust setting. Open Keychain Access and trust 'Caddy Local Authority'.",
  );
  process.exit(1);
}
console.log("Trusted. Restart your browser, then open https://rhumbatron.localhost.");
