import {
  Show,
  SignInButton,
  SignUpButton,
  UserButton,
  useAuth,
  useUser,
} from "@clerk/tanstack-react-start";
import { Button, cn } from "@cloudflare/kumo";
import {
  Airplane,
  ArrowLeft,
  CaretUpDown,
  ClockCounterClockwise,
  Code,
  CurrencyDollar,
  Desktop,
  Folders,
  GearSix,
  GitDiff,
  GitFork,
  Graph,
  type Icon,
  Kanban,
  List,
  Moon,
  Pulse,
  Robot,
  SealCheck,
  ShieldCheck,
  SquaresFour,
  Sun,
  TreeStructure,
  X,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link, type LinkOptions, useLocation, useRouter } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { getMe, ME_KEY } from "../../lib/api-budget";
import { changeLabel } from "../../lib/format";
import { type ShellLiveState, useShellLiveState } from "../../lib/live-status";
import { type ColorMode, useColorMode } from "../../lib/mode";
import { NotificationBell } from "../notifications/notification-bell";
import { SkeletonBar } from "../project/feedback";
import { NewChangeButton } from "./new-change-button";
import { type Crumb, useDocumentTitle, usePageTrail } from "./page-meta";
import {
  changesLink,
  PROJECT_PAGES,
  type ProjectPage,
  projectPageLink,
  type ShellContext,
  type ShellSection,
  useShellContext,
} from "./shell-context";

/**
 * Application shell: elevated 228px sidebar, header with breadcrumb and mode
 * toggle, a main column that scrolls on its own, and a 28px mono status bar. Under 720px the
 * sidebar becomes a top bar whose navigation opens as a disclosure.
 *
 * Pages render inside `#content`. Use `<Page>` from components/ui/page for the page padding and
 * 1320px max width; it renders the page's <main> landmark.
 */
/**
 * TanStack marks a link active (and sets aria-current="page") when the route matches fuzzily,
 * so "/" would be "current" everywhere. Shell links only match their exact path.
 */
const EXACT = { exact: true } as const;
/** Sidebar rows: Overview and Changes share a path and differ by the `#changes` hash. */
const EXACT_WITH_HASH = { exact: true, includeHash: true } as const;

export type BuildInfo = { service: string; environment: string };

export function AppShell({ build, children }: { build: BuildInfo; children: ReactNode }) {
  const context = useShellContext();
  useDocumentTitle(context.title);
  return (
    <div
      className={cn(
        "grid h-dvh min-h-0 grid-cols-[228px_minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto]",
        "max-[720px]:grid-cols-[minmax(0,1fr)] max-[720px]:grid-rows-[auto_auto_minmax(0,1fr)_auto]",
      )}
    >
      <a
        href="#content"
        className="sr-only z-50 bg-kumo-ink px-3 py-2 text-kumo-inverse focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <Sidebar context={context} />
      <Header context={context} />
      <div
        id="content"
        tabIndex={-1}
        // `relative`: absolutely positioned page elements (sr-only text, hidden form inputs)
        // stay inside this scroll box. Without it they extend the document below the status bar.
        className="relative col-start-2 row-start-2 min-h-0 overflow-y-auto outline-none max-[720px]:col-start-1 max-[720px]:row-start-3"
      >
        {children}
      </div>
      <StatusBar build={build} />
    </div>
  );
}
AppShell.displayName = "AppShell";

/* ------------------------------------------------------------------------------------------ */
/* Sidebar                                                                                     */
/* ------------------------------------------------------------------------------------------ */

type NavItem = {
  label: string;
  icon: Icon;
  section?: ShellSection;
  link: LinkOptions;
  /** Short mono note on the right. */
  hint?: string;
  /** Second line under the label: which Change a Change page opens. */
  subtitle?: string;
  /** Full explanation in the tooltip. */
  title?: string;
};

/** A project-scoped page. */
function projectPageItem(projectId: string, section: ProjectPage, icon: Icon): NavItem {
  return {
    label: PROJECT_PAGES[section],
    icon,
    section,
    link: projectPageLink(projectId, section),
  };
}

/**
 * A page of one Change (Flight Control, Candidates): the Change in context, else the newest
 * Change, else the Changes list where the first one starts. Always a link.
 */
function changeScopedItem(
  context: ShellContext,
  projectId: string,
  base: Pick<NavItem, "label" | "icon" | "section">,
  linkFor: (changeId: string) => LinkOptions,
): NavItem {
  if (context.changeId) {
    return {
      ...base,
      link: linkFor(context.changeId),
      ...(context.changeTitle
        ? {
            subtitle: `for: ${context.changeTitle}`,
            title: `${base.label} of: ${context.changeGoal ?? context.changeTitle}`,
          }
        : {}),
    };
  }
  if (context.latestChange) {
    return {
      ...base,
      link: linkFor(context.latestChange.id),
      subtitle: `for: ${changeLabel(context.latestChange)}`,
      title: `${base.label} of the newest Change: ${context.latestChange.goal}`,
    };
  }
  return {
    ...base,
    link: changesLink(projectId),
    ...(context.noChanges
      ? { hint: "no changes", title: "No Changes yet. Start one under New change." }
      : {}),
  };
}

/** Navigation order: Overview first, the Project pages in a fixed order, Settings last. Every item is a link. */
function navItems(context: ShellContext, projectId: string): NavItem[] {
  const { candidateId } = context;
  return [
    {
      label: "Overview",
      icon: SquaresFour,
      section: "overview",
      link: { to: "/projects/$projectId", params: { projectId } },
    },
    { label: "Changes", icon: GitDiff, section: "changes", link: changesLink(projectId) },
    projectPageItem(projectId, "board", Kanban),
    changeScopedItem(
      context,
      projectId,
      { label: "Flight Control", icon: Airplane, section: "flight" },
      (changeId) => ({ to: "/changes/$changeId/flight", params: { changeId } }),
    ),
    projectPageItem(projectId, "graph", Graph),
    candidateId
      ? {
          label: "Candidates",
          icon: GitFork,
          section: "candidates",
          link: { to: "/candidates/$candidateId", params: { candidateId } },
        }
      : changeScopedItem(
          context,
          projectId,
          { label: "Candidates", icon: GitFork, section: "candidates" },
          (changeId) => ({ to: "/compare/$changeId", params: { changeId } }),
        ),
    projectPageItem(projectId, "agents", Robot),
    projectPageItem(projectId, "events", Pulse),
    projectPageItem(projectId, "verification", SealCheck),
    projectPageItem(projectId, "workspace", TreeStructure),
    projectPageItem(projectId, "code", Code),
    projectPageItem(projectId, "versions", ClockCounterClockwise),
    projectPageItem(projectId, "costs", CurrencyDollar),
    projectPageItem(projectId, "settings", GearSix),
  ];
}

/** Number of skeleton rows while the Project of a Change or Candidate loads. */
const SKELETON_ROWS = 14;

function Sidebar({ context }: { context: ShellContext }) {
  const [open, setOpen] = useState(false);
  const { section, projectId, projectName } = context;
  // Close the narrow-screen menu after navigating.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on route section change only
  useEffect(() => setOpen(false), [section, projectId, context.changeId, context.candidateId]);

  return (
    <aside
      aria-label="Primary"
      className="row-span-2 flex min-h-0 flex-col overflow-y-auto bg-kumo-elevated max-[720px]:row-span-1 max-[720px]:max-h-[70dvh]"
    >
      <div className="flex min-h-12 items-center justify-between gap-2 border-b-2 border-kumo-divider px-4">
        <BrandMark />
        <button
          type="button"
          className="hidden size-11 items-center justify-center hover:bg-kumo-faint max-[720px]:flex"
          aria-expanded={open}
          aria-controls="shell-nav"
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <X size={16} /> : <List size={16} />}
        </button>
      </div>

      <div
        id="shell-nav"
        className={cn("flex min-h-0 grow flex-col", !open && "max-[720px]:hidden")}
      >
        {projectId && (
          <div className="border-b border-kumo-rule px-4 py-3">
            <p className="type-kicker text-kumo-subtle">Project</p>
            <Link
              to="/"
              activeOptions={EXACT}
              title="Switch project"
              className="-mx-2 mt-1 flex items-center justify-between gap-2 px-2 py-1.5 hover:bg-kumo-faint"
            >
              <span className="truncate font-semibold">{projectName ?? "Project"}</span>
              <CaretUpDown size={14} className="shrink-0 text-kumo-subtle" aria-hidden />
              <span className="sr-only">, switch project</span>
            </Link>
          </div>
        )}

        <nav aria-label="Main" className="py-2">
          <ul>
            <li>
              <NavRow
                item={{ label: "Projects", icon: Folders, section: "projects", link: { to: "/" } }}
                current={section === "projects"}
              />
            </li>
          </ul>
          <p className="mt-3 px-4 pb-1 text-[10px] tracking-[0.08em] text-kumo-subtle uppercase">
            Project
          </p>
          {projectId ? (
            <ul>
              {navItems(context, projectId).map((item) => (
                <li key={item.label}>
                  <NavRow item={item} current={!!item.section && item.section === section} />
                </li>
              ))}
            </ul>
          ) : context.resolving ? (
            <ul aria-busy="true">
              <li className="sr-only">Loading the project</li>
              {Array.from({ length: SKELETON_ROWS }, (_, row) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows have no identity
                <li key={row} aria-hidden className={cn(rowClasses, "border-transparent")}>
                  <SkeletonBar height={13} className="w-full max-w-[140px]" />
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-1.5 text-[13px] text-kumo-subtle">
              Open a project to see its pages.
            </p>
          )}
        </nav>

        <div className="mt-auto border-t-2 border-kumo-divider">
          <AdminLink current={section === "admin"} />
          <div className="px-4 py-3">
            <Identity />
          </div>
        </div>
      </div>
    </aside>
  );
}

function BrandMark() {
  return (
    <Link to="/" activeOptions={EXACT} className="flex items-center gap-2">
      <span
        aria-hidden
        className="grid size-[22px] shrink-0 place-items-center bg-accent-500 text-[13px] leading-none font-extrabold text-kumo-inverse"
      >
        R
      </span>
      <span className="text-[17px] leading-none font-extrabold tracking-[-0.01em]">Rhumbatron</span>
      {/* The name starts with the visible word (WCAG 2.5.3, label in name). */}
      <span className="sr-only"> home</span>
    </Link>
  );
}

const rowClasses = "flex items-center gap-2.5 border-l-2 py-[7px] pr-4 pl-[14px] text-[14px]";

function NavRow({ item, current }: { item: NavItem; current: boolean }) {
  const IconComponent = item.icon;
  return (
    <Link
      {...item.link}
      activeOptions={EXACT_WITH_HASH}
      aria-current={current ? "page" : undefined}
      title={item.title}
      className={cn(
        rowClasses,
        "transition-colors duration-(--rh-dur-ui)",
        current
          ? "border-accent-500 bg-kumo-base font-semibold"
          : "border-transparent hover:bg-kumo-faint",
      )}
    >
      <IconComponent
        size={16}
        aria-hidden
        className={cn("shrink-0", item.subtitle && "mt-[3px] self-start")}
      />
      <span className="grid min-w-0">
        <span className="truncate">{item.label}</span>
        {item.subtitle && (
          <span className="truncate text-[11px] font-normal text-kumo-subtle">{item.subtitle}</span>
        )}
      </span>
      {item.hint && (
        <span className="ml-auto shrink-0 font-mono text-[10px] font-normal text-kumo-subtle">
          {item.hint}
        </span>
      )}
    </Link>
  );
}

/** The Admin area, above the identity; only for a platform admin (`GET /v1/me`). */
function AdminLink({ current }: { current: boolean }) {
  const { isSignedIn } = useAuth();
  const me = useQuery({
    queryKey: ME_KEY,
    queryFn: () => getMe(),
    enabled: isSignedIn === true,
  });
  if (isSignedIn === false || !me.data?.platformAdmin) return null;
  return (
    <div className="border-b border-kumo-rule py-1">
      <NavRow
        item={{ label: "Admin", icon: ShieldCheck, link: { to: "/admin" } }}
        current={current}
      />
    </div>
  );
}

function Identity() {
  return (
    <>
      <Show when="signed-in">
        <SignedInIdentity />
      </Show>
      <Show when="signed-out">
        <div className="flex flex-wrap gap-2">
          <SignInButton>
            <Button size="sm">Sign in</Button>
          </SignInButton>
          <SignUpButton>
            <Button size="sm">Sign up</Button>
          </SignUpButton>
        </div>
      </Show>
    </>
  );
}

function SignedInIdentity() {
  const { user } = useUser();
  const name = user?.fullName || user?.primaryEmailAddress?.emailAddress;
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      {/* Clerk mounts the 28px avatar after its script loads; reserve the box so the name does not shift. */}
      <span className="grid size-7 shrink-0 place-items-center">
        <UserButton />
      </span>
      {/* The Account page: the user's own monthly budget and spend across Projects. */}
      <Link
        to="/account"
        activeOptions={EXACT}
        title="Account"
        className="-mx-1 grid min-w-0 px-1 py-0.5 hover:bg-kumo-faint"
      >
        <span className="truncate text-[13px] font-semibold">{name ?? "Signed in"}</span>
        {name && user?.fullName && (
          <span className="truncate font-mono text-[11px] text-kumo-subtle">
            {user.primaryEmailAddress?.emailAddress}
          </span>
        )}
        <span className="sr-only">, account</span>
      </Link>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Header                                                                                      */
/* ------------------------------------------------------------------------------------------ */

function Header({ context }: { context: ShellContext }) {
  const extra = usePageTrail();
  const crumbs = [...context.trail, ...extra];
  return (
    <header className="col-start-2 row-start-1 flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b-2 border-kumo-divider bg-kumo-base px-7 py-2 max-[720px]:col-start-1 max-[720px]:row-start-2 max-[720px]:px-4">
      <div className="flex min-w-0 items-center gap-2.5">
        <BackLink crumbs={crumbs} />
        <Breadcrumbs crumbs={crumbs} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {/* Left of the mode toggle: when it appears after sign-in, nothing to its right moves. */}
        <Show when="signed-in">
          {context.projectId && <NewChangeButton projectId={context.projectId} />}
          <NotificationBell />
        </Show>
        <ModeToggle />
      </div>
    </header>
  );
}

/**
 * One level up: the nearest linked crumb before the current one whose path is not the current
 * path (a Candidate goes back to its Change, a Change to the Changes list, a project page to the
 * overview, a project page with a sub-view crumb to the overview too). A real link, so the
 * browser history and "open in new tab" work as usual.
 */
function BackLink({ crumbs }: { crumbs: Crumb[] }) {
  const router = useRouter();
  const pathname = useLocation({ select: (location) => location.pathname });
  const parent = crumbs
    .slice(0, -1)
    .reverse()
    .find((crumb) => crumb.link && router.buildLocation(crumb.link).pathname !== pathname);
  if (!parent?.link || crumbs.length < 2) return null;
  const label = `Back to ${parent.label}`;
  return (
    <Link
      {...parent.link}
      activeOptions={EXACT}
      activeProps={{}}
      title={label}
      aria-label={label}
      className="grid size-7 shrink-0 place-items-center border border-kumo-divider transition-colors duration-(--rh-dur-ui) hover:bg-kumo-tint pointer-coarse:size-11"
    >
      <ArrowLeft size={14} aria-hidden />
    </Link>
  );
}

function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px]">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          const label = (
            <span className={cn(crumb.mono && "font-mono text-[12px]")}>{crumb.label}</span>
          );
          return (
            <li
              key={crumbs
                .slice(0, index + 1)
                .map((c) => c.label)
                .join("/")}
              className="flex min-w-0 items-center gap-x-1.5"
            >
              {index > 0 && (
                <span aria-hidden className="text-kumo-subtle">
                  /
                </span>
              )}
              {last || !crumb.link ? (
                <span
                  aria-current={last ? "page" : undefined}
                  title={crumb.label}
                  className={cn(
                    "max-w-[40ch] truncate",
                    last ? "font-semibold" : "text-kumo-subtle",
                  )}
                >
                  {label}
                </span>
              ) : (
                <Link
                  {...crumb.link}
                  activeOptions={EXACT}
                  title={crumb.label}
                  className="max-w-[28ch] truncate text-kumo-subtle hover:text-kumo-default"
                >
                  {label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

const MODES: { value: ColorMode; label: string; icon: Icon }[] = [
  { value: "light", label: "Light mode", icon: Sun },
  { value: "dark", label: "Dark mode", icon: Moon },
  { value: "system", label: "Follow the system mode", icon: Desktop },
];

/** Segmented control: 1px divider frame, selected option in ink. */
function ModeToggle() {
  const { mode, setMode } = useColorMode();
  return (
    <fieldset className="flex border border-kumo-divider">
      <legend className="sr-only">Color mode</legend>
      {MODES.map(({ value, label, icon: IconComponent }, index) => {
        const selected = mode === value;
        return (
          <button
            key={value}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={selected}
            onClick={() => setMode(value)}
            className={cn(
              "grid size-7 place-items-center transition-colors duration-(--rh-dur-ui) focus-visible:outline-offset-[-2px] pointer-coarse:size-11",
              index > 0 && "border-l border-kumo-divider",
              selected ? "bg-kumo-ink text-kumo-inverse" : "hover:bg-kumo-tint",
            )}
          >
            <IconComponent size={14} aria-hidden />
          </button>
        );
      })}
    </fieldset>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Status bar                                                                                  */
/* ------------------------------------------------------------------------------------------ */

function liveView(state: ShellLiveState): { dot: string; text: string } {
  if (state.status === "idle" || !state.enabled) return { dot: "bg-tone-400", text: "live off" };
  if (state.status === "open") return { dot: "bg-kumo-success", text: "live" };
  if (state.status === "connecting") return { dot: "bg-kumo-warning", text: "connecting" };
  if (state.status === "reconnecting") return { dot: "bg-kumo-warning", text: "reconnecting" };
  return { dot: "bg-kumo-danger", text: "offline · retrying" };
}

function StatusBar({ build }: { build: BuildInfo }) {
  const live = liveView(useShellLiveState());
  return (
    <footer className="col-span-2 row-start-3 flex h-7 items-center gap-[18px] overflow-hidden border-t-2 border-kumo-divider bg-kumo-elevated px-4 font-mono text-[11px] whitespace-nowrap text-kumo-subtle max-[720px]:col-span-1 max-[720px]:row-start-4">
      <span role="status" className="flex items-center gap-1.5">
        <span aria-hidden className={cn("size-1.5 shrink-0", live.dot)} />
        {live.text}
      </span>
      <span>env {build.environment}</span>
      <span>{build.service}</span>
    </footer>
  );
}
