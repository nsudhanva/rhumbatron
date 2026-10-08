import {
  ClerkProvider,
  Show,
  SignInButton,
  SignUpButton,
  UserButton,
} from "@clerk/tanstack-react-start";
import { Button, Text } from "@cloudflare/kumo";
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  HeadContent,
  Link,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import appCss from "../styles.css?url";

type RouterContext = {
  queryClient: QueryClient;
};

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Rhumbatron" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <AppHeader />
      <Outlet />
    </RootDocument>
  );
}

function AppHeader() {
  return (
    <header className="sticky top-0 z-10 border-b border-kumo-line bg-kumo-base">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
        <Link to="/">
          <Text variant="heading">Rhumbatron</Text>
        </Link>
        <nav className="flex items-center gap-2">
          <Show when="signed-out">
            <SignInButton>
              <Button variant="ghost" size="sm">
                Sign in
              </Button>
            </SignInButton>
            <SignUpButton>
              <Button variant="primary" size="sm">
                Sign up
              </Button>
            </SignUpButton>
          </Show>
          <Show when="signed-in">
            <UserButton />
          </Show>
        </nav>
      </div>
    </header>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="bg-kumo-elevated">
        <ClerkProvider>
          {children}
          <Scripts />
        </ClerkProvider>
      </body>
    </html>
  );
}
