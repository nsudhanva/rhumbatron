/**
 * Trusts the local stack's certificate authority on this Mac, so browsers accept
 * https://rhumbatron.localhost and its subdomains without a warning.
 * Caddy (the `edge` service) creates the CA on its first start. This script copies the root
 * certificate out of the container to `.local-ca.crt` and adds it to the System keychain, which
 * asks for your password once. Bun and Node scripts can use the same file:
 *   NODE_EXTRA_CA_CERTS=.local-ca.crt bun scripts/smoke.ts
 */
import { join } from "node:path";
import { $ } from "bun";

const root = join(import.meta.dir, "..");
const target = join(root, ".local-ca.crt");

await $`docker compose cp edge:/data/caddy/pki/authorities/local/root.crt ${target}`.cwd(root);
console.log(`Copied the local CA to ${target}.`);
if (process.platform !== "darwin") {
  console.log(
    "Add it to your system trust store, for example: sudo cp .local-ca.crt /usr/local/share/ca-certificates/rhumbatron.crt && sudo update-ca-certificates",
  );
  process.exit(0);
}
await $`sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${target}`;
console.log("Trusted. Restart the browser if it was open.");
