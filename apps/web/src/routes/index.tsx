import { env } from "cloudflare:workers";
import { LayerCard } from "@cloudflare/kumo";
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

const getBuildInfo = createServerFn().handler(() => ({
  service: env.SERVICE_NAME,
  environment: env.ENVIRONMENT,
}));

export const Route = createFileRoute("/")({
  loader: () => getBuildInfo(),
  component: Home,
});

function Home() {
  const info = Route.useLoaderData();
  return (
    <main className="mx-auto max-w-3xl p-8">
      <LayerCard>
        <LayerCard.Secondary className="font-mono text-xs">
          {info.service} · {info.environment}
        </LayerCard.Secondary>
        <LayerCard.Primary>
          <h1 className="text-2xl font-semibold">Rhumbatron</h1>
          <p className="mt-2 text-sm text-kumo-subtle">
            Many Agents can propose many futures. Only verified evidence can advance the Canonical
            State.
          </p>
        </LayerCard.Primary>
      </LayerCard>
    </main>
  );
}
