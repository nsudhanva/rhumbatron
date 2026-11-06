/**
 * Enforces project policy that generic linters cannot express.
 * - A local secret file is never tracked, even when force-added past .gitignore.
 * - Only the socket proxy mounts the Docker socket. Access to the socket is root on the host, so
 *   every other service reaches Docker through the proxy's allowlist.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { $ } from "bun";

const root = resolve(import.meta.dir, "..");

const tracked = (await $`git ls-files --cached --others --exclude-standard`.cwd(root).text())
  .split("\n")
  .filter(Boolean);

const failures: string[] = [];

const secretFile = /(^|\/)(\.env(\..+)?|\.dev\.vars(\..+)?)$/;
const allowedExample = /\.env\.example$|\.dev\.vars\.example$/;
for (const file of tracked) {
  if (secretFile.test(file) && !allowedExample.test(file)) {
    failures.push(`${file} [no-tracked-secret-file] Local secret files must not be committed.`);
  }
}

const composeFile = /(^|\/)(compose|docker-compose)(\.[a-z0-9.-]+)?\.ya?ml$/;
for (const file of tracked.filter((f) => composeFile.test(f))) {
  let text: string;
  try {
    text = await readFile(resolve(root, file), "utf8");
  } catch {
    continue;
  }
  let service = "";
  for (const [index, line] of text.split("\n").entries()) {
    const header = /^ {2}([a-z0-9-]+):\s*$/.exec(line);
    if (header) service = header[1] as string;
    if (line.includes("/var/run/docker.sock") && service !== "socket-proxy") {
      failures.push(
        `${file}:${index + 1} [docker-socket] Only the socket-proxy service may mount the Docker socket.`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  console.error(`\n${failures.length} guardrail violation(s).`);
  process.exit(1);
}
console.log(`Guardrails passed (${tracked.length} files scanned).`);
