import { useAuth } from "@clerk/tanstack-react-start";
import { buttonVariants, cn } from "@cloudflare/kumo";
import { useQuery } from "@tanstack/react-query";
import { Link, type LinkOptions } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { getMe, ME_KEY } from "../../lib/api-budget";
import { SkeletonBar } from "../project/feedback";
import { type Crumb, useDocumentTitle, usePageMeta } from "../shell/page-meta";
import { EmptyState } from "../ui/empty-state";
import { Page, PageTitle } from "../ui/page";

/**
 * The platform admin area. Only a platform admin (`GET /v1/me` `platformAdmin`) sees it; anyone
 * else gets a plain "Not found", and the page makes no admin read (the admin queries live in the
 * page body, which mounts only for an admin; the server loaders use `loadForAdmin`).
 *
 * The area is read-only, except the sign-up approval switch and the access decisions (Access).
 */

const TABS: { label: string; link: LinkOptions; exact?: boolean }[] = [
  { label: "Overview", link: { to: "/admin" }, exact: true },
  { label: "Users", link: { to: "/admin/users" } },
  { label: "Projects", link: { to: "/admin/projects" } },
  { label: "Costs", link: { to: "/admin/costs" } },
  { label: "Events", link: { to: "/admin/events" } },
  { label: "Access", link: { to: "/admin/access" } },
];

/**
 * One admin page: the gate, the title block, the tab row and the content. `trail` adds crumbs
 * after "Admin" (the last crumb is the current page).
 */
export function AdminPage({
  title,
  meta,
  actions,
  trail,
  children,
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  trail: Crumb[];
  children: ReactNode;
}) {
  const { isSignedIn } = useAuth();
  const me = useQuery({
    queryKey: ME_KEY,
    queryFn: () => getMe(),
    enabled: isSignedIn === true,
  });
  const admin = isSignedIn !== false && me.data?.platformAdmin === true;
  const loading = isSignedIn !== false && !me.data && !me.isError;

  if (admin) {
    return (
      <AdminContent title={title} meta={meta} actions={actions} trail={trail}>
        {children}
      </AdminContent>
    );
  }
  if (loading) {
    return (
      <Page>
        <div className="grid gap-2" role="status" aria-label="Loading">
          <SkeletonBar height={13} className="w-1/4" />
          <SkeletonBar height={13} className="w-1/2" />
        </div>
      </Page>
    );
  }
  return <NotFound />;
}
AdminPage.displayName = "AdminPage";

function AdminContent({
  title,
  meta,
  actions,
  trail,
  children,
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  trail: Crumb[];
  children: ReactNode;
}) {
  usePageMeta({ trail: [{ label: "Admin", link: { to: "/admin" } }, ...trail] });
  // The routes keep the plain "Rhumbatron" title, so a non-admin's tab never names the area.
  useDocumentTitle(`${trail.at(-1)?.label ?? "Overview"} · Admin · Rhumbatron`);
  return (
    <Page>
      <div className="grid gap-4">
        <PageTitle kicker="Admin" title={title} meta={meta} actions={actions} />
        <AdminTabs />
      </div>
      {children}
    </Page>
  );
}

/** Tabs: the track is the 2px divider; the current tab carries a 2px ink underline. */
function AdminTabs() {
  return (
    <nav aria-label="Admin" className="overflow-x-auto border-b-2 border-kumo-divider">
      <ul className="flex min-w-max">
        {TABS.map((tab) => (
          <li key={tab.label}>
            <Link
              {...tab.link}
              activeOptions={{ exact: tab.exact ?? false, includeSearch: false }}
              className={cn(
                "-mb-0.5 block border-b-2 border-transparent px-3 py-2 text-[14px] transition-colors duration-(--rh-dur-ui) hover:bg-kumo-faint pointer-coarse:py-3",
                "data-[status=active]:border-kumo-ink data-[status=active]:font-semibold",
              )}
            >
              {tab.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** What a non-admin (or a signed-out visitor) sees at any admin address. */
function NotFound() {
  usePageMeta({ trail: [{ label: "Not found" }] });
  useDocumentTitle("Not found · Rhumbatron");
  return (
    <Page>
      <PageTitle title="Not found" />
      <EmptyState
        what="There is no page at this address."
        how="Check the link, or go back to your Projects."
        action={
          <Link to="/" className={buttonVariants({ variant: "secondary" })}>
            Open Projects
          </Link>
        }
      />
    </Page>
  );
}
NotFound.displayName = "NotFound";
