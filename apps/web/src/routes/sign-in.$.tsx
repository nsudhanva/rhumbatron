import { ClerkFailed, ClerkLoading, SignIn } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { AuthCardPlaceholder } from "../components/shell/auth-card-placeholder";
import { loadClerk } from "../lib/clerk-deferral";

export const Route = createFileRoute("/sign-in/$")({
  head: () => ({
    meta: [
      { title: "Sign in · Rhumbatron" },
      { name: "description", content: "Sign in to Rhumbatron to open your projects." },
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
          title="Sign in to Rhumbatron"
          subtitle="Welcome back! Please sign in to continue"
          alternate={{ prompt: "Don't have an account?", label: "Sign up", to: "/sign-up/$" }}
        />
      </ClerkLoading>
      <ClerkFailed>
        <h1 className="sr-only">Sign in to Rhumbatron</h1>
      </ClerkFailed>
      <SignIn />
    </main>
  );
}
