import { SignOutButton, useAuth } from "@clerk/tanstack-react-start";
import { Button } from "@cloudflare/kumo";
import { SignOut } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { isBlocked } from "../../lib/access";
import { getMe, ME_KEY } from "../../lib/api-budget";

/**
 * Access gate. When `GET /v1/me` says the signed-in account is pending or declined, every route
 * shows one full-page message with sign-out, and no shell, no Project data and no page content.
 *
 * The root route reads `GET /v1/me` on the server before any page loader, and the loaders skip
 * their reads for a blocked account (lib/ssr-data.ts). The API answers every other route with
 * 403 `approval_required` for such an account; router.tsx reads `GET /v1/me` again when that
 * happens, so the gate also appears when approval is withdrawn while a page is open. The query
 * refetches on window focus, so an approved account sees the app when the person comes back.
 */
export function AccessGate({ children }: { children: ReactNode }) {
  const { isSignedIn } = useAuth();
  const me = useQuery({
    queryKey: ME_KEY,
    queryFn: () => getMe(),
    enabled: isSignedIn === true,
  });
  const status = me.data?.accessStatus;
  if (isSignedIn !== false && isBlocked(status)) {
    return <AccessMessage status={status} email={me.data?.email ?? null} />;
  }
  return children;
}
AccessGate.displayName = "AccessGate";

const COPY = {
  pending: {
    title: "Your account is waiting for approval",
    body: "New accounts need approval from the Rhumbatron administrator before they can open Projects. You can use Rhumbatron as soon as your account is approved. Come back to this page to check.",
  },
  declined: {
    title: "Your account was not approved",
    body: "The Rhumbatron administrator did not approve this account, so it cannot open Projects. Sign out to use another account.",
  },
} as const;

function AccessMessage({
  status,
  email,
}: {
  status: "pending" | "declined";
  email: string | null;
}) {
  const copy = COPY[status];
  return (
    <div className="grid min-h-dvh grid-rows-[auto_minmax(0,1fr)] bg-kumo-base">
      <div className="flex min-h-12 items-center gap-2 border-b-2 border-kumo-divider bg-kumo-elevated px-4">
        <span
          aria-hidden
          className="grid size-[22px] shrink-0 place-items-center bg-accent-500 text-[13px] leading-none font-extrabold text-kumo-inverse"
        >
          R
        </span>
        <span className="text-[17px] leading-none font-extrabold tracking-[-0.01em]">
          Rhumbatron
        </span>
      </div>
      <main className="grid w-full max-w-[760px] content-start gap-6 px-7 pt-12 pb-12 max-[720px]:px-4">
        <div className="grid gap-2">
          <p className="type-kicker text-kumo-accent">Account</p>
          <h1 className="type-h2 text-balance">{copy.title}</h1>
        </div>
        <p className="type-body text-pretty">{copy.body}</p>
        {email && (
          <p className="text-[13px] text-kumo-subtle">
            Signed in as <span className="font-mono text-[12px] text-kumo-default">{email}</span>
          </p>
        )}
        <div>
          <SignOutButton>
            <Button variant="primary" icon={SignOut}>
              Sign out
            </Button>
          </SignOutButton>
        </div>
      </main>
    </div>
  );
}
AccessMessage.displayName = "AccessMessage";
