/**
 * Applies unapplied D1 migrations to a remote database through the D1 HTTP API.
 * Invoked only by Terraform (terraform_data in the env root).
 * Each migration and its bookkeeping row run in one batch request.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type AppliedMigration,
  type LocalMigration,
  MIGRATION_NAME,
  planMigrations,
} from "./lib/d1-migrations.ts";

if (process.env.RHUMBATRON_INVOKED_BY !== "terraform") {
  console.error(
    "d1-migrate runs only from terraform apply. See infrastructure/terraform/README.md.",
  );
  process.exit(2);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}.`);
    process.exit(2);
  }
  return value;
}

const token = required("CLOUDFLARE_API_TOKEN");
const accountId = required("D1_ACCOUNT_ID");
const databaseId = required("D1_DATABASE_ID");
const migrationsDir = resolve(import.meta.dir, "../migrations/d1");
const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;

type QueryResult = { results?: Record<string, unknown>[] };

async function query(sql: string): Promise<QueryResult[]> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ sql }),
  });
  const body = (await response.json()) as {
    success: boolean;
    errors?: { message: string }[];
    result?: QueryResult[];
  };
  if (!response.ok || !body.success) {
    const message = body.errors?.map((e) => e.message).join("; ") || `HTTP ${response.status}`;
    throw new Error(`D1 query failed: ${message}`);
  }
  return body.result ?? [];
}

// Same shape as Wrangler's table, plus sha256 to detect edited migrations.
await query(
  "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL, sha256 TEXT)",
);

const appliedRows =
  (await query("SELECT name, sha256 FROM d1_migrations ORDER BY id"))[0]?.results ?? [];
const applied: AppliedMigration[] = appliedRows.map((row) => ({
  name: String(row.name),
  sha256: row.sha256 == null ? null : String(row.sha256),
}));

const local: LocalMigration[] = [];
for (const name of (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql"))) {
  const sql = await readFile(join(migrationsDir, name), "utf8");
  local.push({ name, sql, sha256: createHash("sha256").update(sql).digest("hex") });
}

const plan = planMigrations(local, applied);
if (plan.errors.length > 0) {
  console.error(plan.errors.join("\n"));
  process.exit(1);
}

for (const migration of plan.pending) {
  // Name and hash are validated (regex and hex), so inlining them is safe.
  if (!MIGRATION_NAME.test(migration.name) || !/^[0-9a-f]{64}$/.test(migration.sha256)) {
    throw new Error(`Refusing unsafe migration metadata for ${migration.name}`);
  }
  const record = `INSERT INTO d1_migrations (name, sha256) VALUES ('${migration.name}', '${migration.sha256}')`;
  await query(`${migration.sql.trim().replace(/;?\s*$/, ";")}\n${record};`);
  console.log(`applied ${migration.name}`);
}

console.log(
  plan.pending.length === 0
    ? `No pending migrations (${applied.length} applied).`
    : `Applied ${plan.pending.length} migration(s).`,
);
