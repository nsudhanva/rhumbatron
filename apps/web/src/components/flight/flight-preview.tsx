import { useMemo } from "react";
import { previewFlightInput } from "./flight-fixture";
import { deriveFlight } from "./flight-model";
import { FlightPage } from "./flight-page";

/**
 * Fixture-driven Flight Control for `/design/flight`: the real page body over
 * `previewFlightInput()`, labelled as a fixture. Never shown on a product page.
 */
export function FlightPreview() {
  const model = useMemo(() => deriveFlight(previewFlightInput()), []);
  return (
    <FlightPage
      model={model}
      ready
      socket="closed"
      projectId="proj_preview"
      changeId="chg_preview"
      fixture
    />
  );
}
FlightPreview.displayName = "FlightPreview";
