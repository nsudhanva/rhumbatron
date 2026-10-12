/**
 * D1 migration guard for CI. Terraform applies migrations before it deploys new Worker versions,
 * and the old Workers keep serving until then, so every migration must work with the code that
 * runs before it (expand first, contract later).
 *
 * Rules against the base commit (BASE_SHA, else origin/main):
 * 1. Migrations are append-only. A change, rename, or removal of an existing file fails.
 * 2. A file is named NNNN_description.sql with a unique number, and a new file sorts last.
 * 3. A new file with DROP TABLE, DROP COLUMN, or RENAME fails, unless it has the line
 *    `-- destructive: reviewed` after a person checked that no running code reads the old shape.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "migrations/d1";
const NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;
const DESTRUCTIVE = /\b(DROP\s+TABLE|DROP\s+COLUMN|RENAME\s+(TO|COLUMN))\b/i;
const REVIEWED = /^--\s*destructive:\s*reviewed\s*$/im;

export function checkMigrations(input: {
  changes: { status: string; path: string }[];
  files: string[];
  read: (name: string) => string;
}): string[] {
  const errors: string[] = [];
  const added = new Set<string>();
  for (const { status, path } of input.changes) {
    if (!path.startsWith(`${DIR}/`) || !path.endsWith(".sql")) continue;
    const name = path.slice(DIR.length + 1);
    if (status.startsWith("A")) added.add(name);
    else errors.push(`${name}: existing migrations are append-only (git status ${status})`);
  }
  const numbers = new Map<number, string>();
  let lastExisting = 0;
  for (const name of input.files.filter((f) => f.endsWith(".sql"))) {
    const match = NAME.exec(name);
    if (!match) {
      errors.push(`${name}: name must match NNNN_description.sql`);
      continue;
    }
    const n = Number(match[1]);
    const other = numbers.get(n);
    if (other) errors.push(`${name}: number ${match[1]} is also used by ${other}`);
    numbers.set(n, name);
    if (!added.has(name)) lastExisting = Math.max(lastExisting, n);
  }
  for (const name of added) {
    const n = Number(NAME.exec(name)?.[1] ?? 0);
    if (n && n <= lastExisting)
      errors.push(`${name}: a new migration must sort after ${lastExisting}`);
  }
  for (const name of added) {
    const text = input.read(name);
    if (DESTRUCTIVE.test(text) && !REVIEWED.test(text)) {
      errors.push(`${name}: DROP or RENAME needs the line "-- destructive: reviewed"`);
    }
  }
  return errors;
}

if (import.meta.main) {
  const base = process.env.BASE_SHA?.trim() || "origin/main";
  const git = (...args: string[]) => {
    try {
      return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return null;
    }
  };
  const known = git("rev-parse", "--verify", "--quiet", `${base}^{commit}`) !== null;
  const diff = known
    ? (git("diff", "--name-status", "--no-renames", base, "HEAD", "--", DIR) ?? "").trim()
    : "";
  const changes = diff
    ? diff.split("\n").map((line) => {
        const [status = "", path = ""] = line.split("\t");
        return { status, path };
      })
    : [];
  const errors = checkMigrations({
    changes,
    files: readdirSync(DIR),
    read: (name) => readFileSync(join(DIR, name), "utf8"),
  });
  if (!known) console.warn(`check-migrations: base ${base} not found; checked names only.`);
  if (errors.length > 0) {
    for (const e of errors) console.error(`check-migrations: ${e}`);
    process.exit(1);
  }
  console.log(`check-migrations: ${changes.length} change(s) against ${base}, all valid.`);
}
