import { cn } from "@cloudflare/kumo";
import { type ReactNode, useId } from "react";

/**
 * Page anatomy. A page is:
 *
 *   <Page>
 *     <PageTitle kicker="Project" title={project.name} actions={<Button variant="primary">…</Button>} />
 *     <StatStrip>…</StatStrip>
 *     <Section label="Changes" meta={<Mono subtle>{count}</Mono>}>…rows…</Section>
 *     <TwoUp>
 *       <Section label="Acceptance criteria">…</Section>
 *       <Section label="Protected invariants">…</Section>
 *     </TwoUp>
 *   </Page>
 */

/**
 * The page's <main> landmark: max 1320px, padding 24 top / 28 sides / 48 bottom (16px sides
 * on narrow screens), 28px between sections. Pass `gap="tight"` for 24px. Pass `width="full"`
 * for a full-bleed console (Flight Control) that keeps the same padding without the max width.
 */
export function Page({
  children,
  gap = "normal",
  width = "page",
  className,
}: {
  children: ReactNode;
  gap?: "normal" | "tight";
  width?: "page" | "full";
  className?: string;
}) {
  return (
    <main
      className={cn(
        "mx-auto grid w-full content-start px-7 pt-6 pb-12 max-[720px]:px-4",
        width === "page" && "max-w-[1320px]",
        gap === "normal" ? "gap-7" : "gap-6",
        className,
      )}
    >
      {children}
    </main>
  );
}
Page.displayName = "Page";

/**
 * Title block: kicker (uppercase, accent) above the h1, page actions aligned bottom right.
 * Actions wrap below the title on narrow widths. One h1 per page. `size="detail"` uses the
 * 32px h2 scale for detail pages (Change, Candidate), still rendered as the page's <h1>.
 * `meta` is an optional line under the title (mono IDs, base generation, age).
 */
export function PageTitle({
  kicker,
  title,
  meta,
  actions,
  size = "page",
  className,
}: {
  kicker?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  size?: "page" | "detail";
  className?: string;
}) {
  return (
    <header className={cn("flex flex-wrap items-end justify-between gap-x-6 gap-y-3", className)}>
      <div className="grid min-w-0 gap-2">
        {kicker && <p className="type-kicker text-kumo-accent">{kicker}</p>}
        <h1 className={cn("min-w-0 break-words", size === "page" ? "type-h1" : "type-h2")}>
          {title}
        </h1>
        {meta && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-kumo-subtle">
            {meta}
          </div>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
PageTitle.displayName = "PageTitle";

/**
 * Section label row: the `h6` style label on the left, an optional count,
 * meta or ghost link on the right, above a 2px divider. Renders an <h2> by default so the
 * document outline stays correct; pass `as="h3"` inside a sub-section.
 */
export function SectionLabel({
  children,
  meta,
  as: Heading = "h2",
  id,
  className,
}: {
  children: ReactNode;
  meta?: ReactNode;
  as?: "h2" | "h3" | "h4";
  id?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-7 items-end justify-between gap-3 border-b-2 border-kumo-divider pb-2",
        className,
      )}
    >
      <Heading id={id} className="type-h6">
        {children}
      </Heading>
      {meta && (
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 text-[12px] text-kumo-subtle">
          {meta}
        </div>
      )}
    </div>
  );
}
SectionLabel.displayName = "SectionLabel";

/** A labelled section: SectionLabel, then the content 12px below the divider. */
export function Section({
  label,
  meta,
  as,
  id: sectionId,
  children,
  className,
}: {
  label: ReactNode;
  meta?: ReactNode;
  as?: "h2" | "h3" | "h4";
  /** Anchor id of the section, for links such as `#changes`. */
  id?: string;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section
      id={sectionId}
      aria-labelledby={id}
      className={cn("grid min-w-0 scroll-mt-6 content-start gap-3", className)}
    >
      <SectionLabel id={id} meta={meta} {...(as ? { as } : {})}>
        {label}
      </SectionLabel>
      {children}
    </section>
  );
}
Section.displayName = "Section";

/** Two-up row: columns of at least 420px that wrap, 28px gap. */
export function TwoUp({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "grid grid-cols-[repeat(auto-fit,minmax(min(100%,420px),1fr))] gap-7",
        className,
      )}
    >
      {children}
    </div>
  );
}
TwoUp.displayName = "TwoUp";
