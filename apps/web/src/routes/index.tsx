import { env } from "cloudflare:workers";
import { LayerCard, Text } from "@cloudflare/kumo";
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
    <main className="mx-auto max-w-5xl px-6 py-8">
      <LayerCard>
        <LayerCard.Secondary className="px-5 py-2.5">
          <Text variant="mono-secondary">
            {info.service} · {info.environment}
          </Text>
        </LayerCard.Secondary>
        <LayerCard.Primary className="grid gap-1.5 px-5 py-4">
          <Text as="h1" variant="heading" size="lg">
            Rhumbatron
          </Text>
          <Text variant="secondary">
            Many Agents can propose many futures. Only verified evidence can advance the Canonical
            State.
          </Text>
        </LayerCard.Primary>
      </LayerCard>
    </main>
  );
}
