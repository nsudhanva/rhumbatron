import { Show, SignInButton, SignUpButton, UserButton, useUser } from "@clerk/tanstack-react-start";
import { Button, cn, Switch } from "@cloudflare/kumo";
import {
  Bug,
  CaretDown,
  CaretRight,
  CaretUpDown,
  Code,
  CurrencyDollar,
  Desktop,
  Folders,
  Graph,
  type Icon,
  List,
  ListDashes,
  Moon,
  Pulse,
  Robot,
  SealCheck,
  SquaresFour,
  Sun,
  X,
} from "@phosphor-icons/react";
import { Link, type LinkOptions } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import type { GlossaryKey } from "../../lib/glossary";
import { type ShellLiveState, useShellLiveState } from "../../lib/live-status";
import { type ColorMode, useColorMode } from "../../lib/mode";
import { setViewMode, useViewMode } from "../../lib/view-mode";
import { NotificationBell } from "../notifications/notification-bell";
import { termHint } from "../ui/term";
import { type Crumb, usePageTrail } from "./page-meta";
import {
  PROJECT_PAGES,
  type ProjectPage,
  projectPageLink,
  type ShellContext,
  type ShellSection,
  useShellContext,
} from "./shell-context";

/**
 * Application shell (research 7.1): a 228px sidebar, a header with the breadcrumb, the
 * notification bell and the color mode, a main column that scrolls on its own, and a status bar.
 * Under 720px the sidebar becomes a top bar whose navigation opens as a disclosure.
 *
 * Pages render inside `#content`. Use `<Page>` from components/ui/page for the page padding and
 * max width; it renders the page's <main> landmark.
 */
/**
 * TanStack marks a link active (and sets aria-current="page") when the route matches fuzzily,
 * so "/" would be "current" everywhere. Shell links only match their exact path.
 */
const EXACT = { exact: true } as const;

export type BuildInfo = { service: string; environment: string };

export function AppShell({ build, children }: { build: BuildInfo; children: ReactNode }) {
  const context = useShellContext();
  return (
    <div
      className={cn(
        "grid h-dvh min-h-0 grid-cols-[228px_minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto]",
        "max-[720px]:grid-cols-[minmax(0,1fr)] max-[720px]:grid-rows-[auto_auto_minmax(0,1fr)_auto]",
      )}
    >
      <a
        href="#content"
        className="sr-only z-50 rounded-md bg-kumo-ink px-3 py-2 text-kumo-inverse focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <Sidebar context={context} />
      <Header context={context} />
      <div
        id="content"
        tabIndex={-1}
        className="col-start-2 row-start-2 min-h-0 overflow-y-auto outline-none max-[720px]:col-start-1 max-[720px]:row-start-3"
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
  link?: LinkOptions;
  /** Shown as the tooltip when the item cannot be opened yet. */
  unavailable?: string;
  /** Plain one-sentence tooltip for the item. */
  hint?: string;
};

const NEEDS_PROJECT = "Open a project first";

/** A project-scoped page: linked whenever a project is in context. */
function projectPageItem(
  projectId: string | undefined,
  section: ProjectPage,
  icon: Icon,
  hint?: GlossaryKey,
): NavItem {
  return {
    label: PROJECT_PAGES[section],
    icon,
    section,
    ...(hint ? { hint: termHint(hint) } : {}),
    ...(projectId ? { link: projectPageLink(projectId, section) } : { unavailable: NEEDS_PROJECT }),
  };
}

/** The everyday pages of a project (research 7.1). Environments and Settings are not built. */
function mainItems({ projectId }: ShellContext): NavItem[] {
  return [
    {
      label: "Overview",
      icon: SquaresFour,
      section: "overview",
      ...(projectId
        ? { link: { to: "/projects/$projectId", params: { projectId } } }
        : { unavailable: NEEDS_PROJECT }),
    },
    projectPageItem(projectId, "activity", Pulse),
    projectPageItem(projectId, "costs", CurrencyDollar),
  ];
}

/** Pages for developers: raw records and the full debugging console. */
function advancedItems({ projectId, changeId }: ShellContext): NavItem[] {
  return [
    projectPageItem(projectId, "agents", Robot, "agent"),
    projectPageItem(projectId, "verification", SealCheck, "checks"),
    projectPageItem(projectId, "workspace", Code, "code"),
    projectPageItem(projectId, "graph", Graph, "productMap"),
    projectPageItem(projectId, "events", ListDashes, "eventLog"),
    {
      label: "Debug view",
      icon: Bug,
      section: "flight",
      hint: termHint("debugView"),
      ...(changeId
        ? { link: { to: "/changes/$changeId/flight", params: { changeId } } }
        : { unavailable: "Open a change first" }),
    },
  ];
}

const ADVANCED_SECTIONS = new Set<ShellSection>([
  "agents",
  "verification",
  "workspace",
  "graph",
  "events",
  "flight",
]);

const ADVANCED_KEY = "rh-nav-advanced";

function readAdvancedOpen(): boolean {
  try {
    return localStorage.getItem(ADVANCED_KEY) === "open";
  } catch {
    // Storage blocked: collapsed by default.
    return false;
  }
}

function storeAdvancedOpen(open: boolean) {
  try {
    localStorage.setItem(ADVANCED_KEY, open ? "open" : "closed");
  } catch {
    // Storage blocked: the choice still applies until the next page load.
  }
}

/**
 * The Advanced group is collapsed by default and remembered per browser. It also opens while
 * one of its pages is current, so the current row is always visible. The server renders that
 * same rule (it knows the route, not the stored choice).
 */
function useAdvancedOpen(section: ShellSection) {
  const inside = ADVANCED_SECTIONS.has(section);
  const [open, setOpen] = useState(inside);
  useEffect(() => {
    setOpen(inside || readAdvancedOpen());
  }, [inside]);
  const toggle = () =>
    setOpen((current) => {
      storeAdvancedOpen(!current);
      return !current;
    });
  return [open, toggle] as const;
}

function Sidebar({ context }: { context: ShellContext }) {
  const [open, setOpen] = useState(false);
  const { section, projectId, projectName } = context;
  const [advancedOpen, toggleAdvanced] = useAdvancedOpen(section);
  // Close the narrow-screen menu after navigating.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on route section change only
  useEffect(() => setOpen(false), [section, projectId, context.changeId, context.candidateId]);

  return (
    <aside
      aria-label="Primary"
      className="row-span-2 flex min-h-0 flex-col overflow-y-auto border-r border-kumo-rule bg-kumo-elevated max-[720px]:row-span-1 max-[720px]:max-h-[70dvh] max-[720px]:border-r-0 max-[720px]:border-b"
    >
      <div className="flex min-h-12 items-center justify-between gap-2 border-b border-kumo-rule px-4">
        <BrandMark />
        <button
          type="button"
          className="hidden size-11 items-center justify-center rounded-md hover:bg-kumo-tint max-[720px]:flex"
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
        <nav aria-label="Main" className="grid gap-3 py-2">
          <ul>
            <li>
              <NavRow
                item={{ label: "Projects", icon: Folders, section: "projects", link: { to: "/" } }}
                current={section === "projects"}
              />
            </li>
          </ul>

          {projectId && (
            <div className="px-4">
              <p className="text-[12px] font-medium text-kumo-subtle">Project</p>
              <Link
                to="/"
                activeOptions={EXACT}
                title="Switch project"
                className="-mx-2 mt-0.5 flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-kumo-tint"
              >
                <span className="truncate font-semibold">{projectName ?? "Project"}</span>
                <CaretUpDown size={16} className="shrink-0 text-kumo-subtle" aria-hidden />
                <span className="sr-only">, switch project</span>
              </Link>
            </div>
          )}

          <ul>
            {mainItems(context).map((item) => (
              <li key={item.label}>
                <NavRow item={item} current={!!item.section && item.section === section} />
              </li>
            ))}
          </ul>

          <div className="border-t border-kumo-rule pt-2">
            <button
              type="button"
              aria-expanded={advancedOpen}
              aria-controls="shell-nav-advanced"
              onClick={toggleAdvanced}
              className="flex h-9 w-full items-center gap-2 px-4 text-[12px] font-medium text-kumo-subtle hover:text-kumo-default focus-visible:outline-offset-[-2px]"
            >
              {advancedOpen ? (
                <CaretDown size={12} aria-hidden />
              ) : (
                <CaretRight size={12} aria-hidden />
              )}
              Advanced
            </button>
            <div id="shell-nav-advanced" hidden={!advancedOpen}>
              <ul>
                {advancedItems(context).map((item) => (
                  <li key={item.label}>
                    <NavRow item={item} current={!!item.section && item.section === section} />
                  </li>
                ))}
              </ul>
              <TechnicalDetailsSwitch />
            </div>
          </div>
        </nav>

        <div className="mt-auto border-t border-kumo-rule px-4 py-3">
          <Identity />
        </div>
      </div>
    </aside>
  );
}

/** Shows IDs, event types and internal names on pages that support it (lib/view-mode). */
function TechnicalDetailsSwitch() {
  const view = useViewMode();
  return (
    <div className="px-4 pt-2 pb-1 text-[13px]">
      <Switch
        size="sm"
        label="Show technical details"
        checked={view === "systems"}
        onCheckedChange={(checked) => setViewMode(checked ? "systems" : "product")}
      />
    </div>
  );
}

function BrandMark() {
  return (
    <Link to="/" activeOptions={EXACT} className="flex items-center gap-2">
      <span
        aria-hidden
        className="grid size-6 shrink-0 place-items-center rounded-md bg-accent-500 text-[13px] leading-none font-semibold text-white"
      >
        R
      </span>
      <span className="text-[16px] leading-none font-semibold">Rhumbatron</span>
      {/* The name starts with the visible word (WCAG 2.5.3, label in name). */}
      <span className="sr-only"> home</span>
    </Link>
  );
}

const rowClasses = "flex h-9 items-center gap-2.5 border-l-2 pr-4 pl-[14px] text-[14px]";

function NavRow({ item, current }: { item: NavItem; current: boolean }) {
  const IconComponent = item.icon;
  const content = (
    <>
      <IconComponent size={16} aria-hidden className="shrink-0" />
      <span className="truncate">{item.label}</span>
    </>
  );
  if (!item.link) {
    return (
      <span
        aria-disabled="true"
        title={item.unavailable}
        className={cn(rowClasses, "cursor-not-allowed border-transparent text-kumo-subtle")}
      >
        {content}
      </span>
    );
  }
  return (
    <Link
      {...item.link}
      activeOptions={EXACT}
      title={item.hint}
      aria-current={current ? "page" : undefined}
      className={cn(
        rowClasses,
        "transition-colors duration-(--rh-dur-ui)",
        current
          ? "border-kumo-info bg-kumo-info-tint font-medium text-kumo-info"
          : "border-transparent hover:bg-kumo-tint",
      )}
    >
      {content}
    </Link>
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
      <div className="grid min-w-0">
        <span className="truncate text-[13px] font-semibold">{name ?? "Signed in"}</span>
        {name && user?.fullName && (
          <span className="truncate text-[12px] text-kumo-subtle">
            {user.primaryEmailAddress?.emailAddress}
          </span>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Header                                                                                      */
/* ------------------------------------------------------------------------------------------ */

function Header({ context }: { context: ShellContext }) {
  const extra = usePageTrail();
  return (
    <header className="col-start-2 row-start-1 flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-kumo-rule bg-kumo-base px-7 py-2 max-[720px]:col-start-1 max-[720px]:row-start-2 max-[720px]:px-4">
      <Breadcrumbs crumbs={[...context.trail, ...extra]} />
      <div className="flex flex-wrap items-center gap-2">
        {/* Left of the mode toggle: when it appears after sign-in, nothing to its right moves. */}
        <Show when="signed-in">
          <NotificationBell />
        </Show>
        <ModeToggle />
      </div>
    </header>
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

/** Segmented control: 1px control border, 6px radius, the selected option on a filled tone. */
function ModeToggle() {
  const { mode, setMode } = useColorMode();
  return (
    <fieldset className="flex overflow-hidden rounded-md border border-kumo-line">
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
              index > 0 && "border-l border-kumo-line",
              selected ? "bg-kumo-info text-white" : "text-kumo-subtle hover:bg-kumo-tint",
            )}
          >
            <IconComponent size={16} aria-hidden />
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
  if (state.status === "idle" || !state.enabled) {
    return { dot: "bg-tone-400", text: "Live updates off" };
  }
  if (state.status === "open") return { dot: "bg-kumo-success", text: "Updating live" };
  if (state.status === "connecting") return { dot: "bg-kumo-warning", text: "Reconnecting..." };
  return { dot: "bg-kumo-danger", text: "Offline, retrying" };
}

function StatusBar({ build }: { build: BuildInfo }) {
  const live = liveView(useShellLiveState());
  return (
    <footer className="col-span-2 row-start-3 flex h-7 items-center gap-[18px] overflow-hidden border-t border-kumo-rule bg-kumo-elevated px-4 text-[12px] whitespace-nowrap text-kumo-subtle max-[720px]:col-span-1 max-[720px]:row-start-4">
      <span role="status" className="flex items-center gap-1.5">
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", live.dot)} />
        {live.text}
      </span>
      <span className="font-mono">env {build.environment}</span>
      <span className="font-mono">{build.service}</span>
    </footer>
  );
}
