import { ClerkFailed, ClerkLoading, SignUp } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { AuthCardPlaceholder } from "../components/shell/auth-card-placeholder";
import { loadClerk } from "../lib/clerk-deferral";

export const Route = createFileRoute("/sign-up/$")({
  head: () => ({
    meta: [
      { title: "Sign up · Rhumbatron" },
      { name: "description", content: "Create a Rhumbatron account." },
    ],
  }),
  component: Page,
});

/**
 * Clerk renders the form and, once its script has loaded, the page's h1. Until then a placeholder
 * card of the same size supplies the h1 and the first paint; if Clerk fails to load, the page
 * supplies the h1. There is always exactly one.
 */
function Page() {
  // A client-side visit from a page that held Clerk back starts the load here.
  useEffect(loadClerk, []);
  return (
    <main className="flex min-h-full items-center justify-center px-4 py-6">
      <ClerkLoading>
        <AuthCardPlaceholder
          title="Create a Rhumbatron account"
          subtitle="Welcome! Please fill in the details to get started."
          alternate={{ prompt: "Already have an account?", label: "Sign in", to: "/sign-in/$" }}
        />
      </ClerkLoading>
      <ClerkFailed>
        <h1 className="sr-only">Create a Rhumbatron account</h1>
      </ClerkFailed>
      <SignUp />
    </main>
  );
}
