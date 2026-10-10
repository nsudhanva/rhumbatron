import { createFileRoute } from "@tanstack/react-router";
import { FlightPreview } from "../components/flight/flight-preview";
import { Page, PageTitle } from "../components/ui/page";

/**
 * Design reference for the Debug view (was Flight Control), rendered from a typed fixture (flight-fixture.ts) so the
 * panels can be checked without a signed-in session. Not a product page: it says so in the title.
 */
export const Route = createFileRoute("/design_/flight")({
  head: () => ({
    meta: [
      { title: "Debug view preview · Rhumbatron" },
      {
        name: "description",
        content: "Design reference for the Rhumbatron Debug view, rendered from a fixture.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: FlightDesignPreview,
});

function FlightDesignPreview() {
  return (
    <Page width="full" gap="tight">
      <PageTitle
        title="Debug view preview"
        meta={
          <span>
            Design reference. Every record below is a fixture shaped like the API. Nothing here is
            live.
          </span>
        }
      />
      <FlightPreview />
    </Page>
  );
}
