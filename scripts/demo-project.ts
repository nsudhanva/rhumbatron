/**
 * Creates the Acme Shop demo Project on dev (or reuses it) and waits for its Artifacts source.
 * Prints the Artifacts repo to connect to Workers Builds (ADR 0014).
 * Usage: bun run demo:project
 */
const api = "https://api-dev.rhumbatron.com";
const secretKey = process.env.CLERK_SECRET_KEY;
const userId = process.env.CLERK_SMOKE_USER_ID;
if (!secretKey || !userId) {
  console.error("CLERK_SECRET_KEY and CLERK_SMOKE_USER_ID are required (see package.json).");
  process.exit(2);
}

async function clerk<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`https://api.clerk.com/v1${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Clerk ${path} returned ${response.status}`);
  return (await response.json()) as T;
}

const session = await clerk<{ id: string }>("/sessions", { user_id: userId });
const headers = async () => {
  const { jwt } = await clerk<{ jwt: string }>(`/sessions/${session.id}/tokens`, {});
  return { authorization: `Bearer ${jwt}`, "content-type": "application/json" };
};
type Project = { id: string; slug: string; canonical: { artifactRef: string; generation: number } };
const get = async <T>(path: string) =>
  ((await (await fetch(`${api}${path}`, { headers: await headers() })).json()) as { data: T }).data;

const slug = "acme-shop-demo";
let project = (await get<Project[]>("/v1/projects")).find((p) => p.slug === slug);
if (!project) {
  const response = await fetch(`${api}/v1/projects`, {
    method: "POST",
    headers: await headers(),
    body: JSON.stringify({ name: "Acme Shop", slug, template: "acme-shop" }),
  });
  if (!response.ok) throw new Error(`create project returned ${response.status}`);
  const id = ((await response.json()) as { data: { id: string } }).data.id;
  console.log(`created ${id}; waiting for source`);
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    project = await get<Project>(`/v1/projects/${id}`);
    if (project.canonical.artifactRef !== "unassigned") break;
    await Bun.sleep(5000);
  }
}
await clerk(`/sessions/${session.id}/revoke`, {});
if (!project || project.canonical.artifactRef === "unassigned") {
  console.error("source not provisioned yet; run again shortly");
  process.exit(1);
}
console.log(`project   ${project.id}`);
console.log(`source    ${project.canonical.artifactRef}  (S${project.canonical.generation})`);
console.log(`namespace rhumbatron-projects-dev`);
console.log(`repo      ${project.id}`);
