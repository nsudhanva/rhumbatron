import { cn } from "@cloudflare/kumo";
import { type ReactNode, useId } from "react";

/**
 * Page anatomy (docs/ux/research-2026-10-09.md 8.3). A page is:
 *
 *   <Page>
 *     <PageTitle kicker="Project" title={project.name} actions={<Button variant="primary">…</Button>} />
 *     <Section label="Changes" meta={<Mono subtle>{count}</Mono>}>…rows…</Section>
 *     <TwoUp>
 *       <Section label="Done when">…</Section>
 *       <Section label="Must not change">…</Section>
 *     </TwoUp>
 *   </Page>
 */

/**
 * The page's <main> landmark: max 1200px, padding 24 top / 24 sides / 48 bottom (16px sides
 * on narrow screens), 32px between sections. Pass `gap="tight"` for 16px (the card gap). Pass
 * `width="full"` for a full-bleed console (Debug view) that keeps the padding without the max
 * width.
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
        "mx-auto grid w-full content-start px-6 pt-6 pb-12 max-[720px]:px-4",
        width === "page" && "max-w-[1200px]",
        gap === "normal" ? "gap-8" : "gap-4",
        className,
      )}
    >
      {children}
    </main>
  );
}
Page.displayName = "Page";

/**
 * Title block: an optional small context line (`kicker`, 12px subtle) above the h1, page
 * actions aligned bottom right. Actions wrap below the title on narrow widths. One h1 per page:
 * 24px, or 20px with `size="detail"` for detail pages (Change, Version) whose title is long.
 * `meta` is an optional line under the title (age, base release, cost).
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
      <div className="grid min-w-0 gap-1">
        {kicker && <p className="type-meta text-kumo-subtle">{kicker}</p>}
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
 * Section label row: a 16px/600 heading on the left, an optional count, meta or link on the
 * right, above a 1px rule. Renders an <h2> by default so the document outline stays correct;
 * pass `as="h3"` inside a sub-section.
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
        "flex min-h-7 items-end justify-between gap-3 border-b border-kumo-rule pb-2",
        className,
      )}
    >
      <Heading id={id} className="type-h3">
        {children}
      </Heading>
      {meta && (
        <div className="flex shrink-0 items-center gap-3 text-[12px] text-kumo-subtle">{meta}</div>
      )}
    </div>
  );
}
SectionLabel.displayName = "SectionLabel";

/** A labelled section: SectionLabel, then the content 12px below the rule. */
export function Section({
  label,
  meta,
  as,
  children,
  className,
}: {
  label: ReactNode;
  meta?: ReactNode;
  as?: "h2" | "h3" | "h4";
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn("grid min-w-0 content-start gap-3", className)}>
      <SectionLabel id={id} meta={meta} {...(as ? { as } : {})}>
        {label}
      </SectionLabel>
      {children}
    </section>
  );
}
Section.displayName = "Section";

/** Two-up row: columns of at least 420px that wrap; 24px between columns, 32px when stacked. */
export function TwoUp({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "grid grid-cols-[repeat(auto-fit,minmax(min(100%,420px),1fr))] gap-x-6 gap-y-8",
        className,
      )}
    >
      {children}
    </div>
  );
}
TwoUp.displayName = "TwoUp";
