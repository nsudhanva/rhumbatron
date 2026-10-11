import { StartClient } from "@tanstack/react-start/client";
import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { deferClerkForSignedOutVisitors } from "./lib/clerk-deferral";

// TanStack Start's default client entry, plus the Clerk load hold that must exist before
// ClerkProvider first renders.
deferClerkForSignedOutVisitors();

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <StartClient />
    </StrictMode>,
  );
});
