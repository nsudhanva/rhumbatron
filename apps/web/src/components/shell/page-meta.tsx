import type { LinkOptions } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

/**
 * Breadcrumb trail for the shell header (DESIGN.md 6.1, 8.3).
 *
 * The shell derives the base trail from the route on its own:
 *   Projects / <project name> / <change goal> / <candidate id>
 * (see `useShellContext`). A page only calls `usePageMeta` to append deeper levels, for
 * example a tab or a sub-view:
 *
 *   usePageMeta({ trail: [{ label: "Evidence" }] });
 *   usePageMeta({ trail: [{ label: "Check", link: { to: "/candidates/$candidateId", params } },
 *                         { label: checkId, mono: true }] });
 *
 * The last crumb is always the current level: it renders at weight 600 and is never a link.
 * Machine identifiers set `mono: true`.
 */
export type Crumb = {
  label: string;
  link?: LinkOptions;
  mono?: boolean;
};

type PageMetaContextValue = {
  trail: Crumb[];
  setTrail: (trail: Crumb[]) => void;
};

const PageMetaContext = createContext<PageMetaContextValue | null>(null);

export function PageMetaProvider({ children }: { children: ReactNode }) {
  const [trail, setTrail] = useState<Crumb[]>([]);
  return (
    <PageMetaContext.Provider value={{ trail, setTrail }}>{children}</PageMetaContext.Provider>
  );
}

/** Appends crumbs after the route-derived trail while the calling page is mounted. */
export function usePageMeta({ trail }: { trail?: Crumb[] }) {
  const setTrail = useContext(PageMetaContext)?.setTrail;
  // Crumbs are plain data; a serialized key keeps the effect from firing on every render.
  const key = JSON.stringify(trail ?? []);
  useEffect(() => {
    if (!setTrail) return;
    setTrail(JSON.parse(key) as Crumb[]);
    return () => setTrail([]);
  }, [key, setTrail]);
}

export function usePageTrail(): Crumb[] {
  return useContext(PageMetaContext)?.trail ?? [];
}

/** The `(n) ` count the notification bell puts in front of the title. */
const COUNT_PREFIX = /^\(\d+\+?\) /;

/**
 * Sets the tab title to `title` (the shell passes "<Page> · <Project or Change> · Rhumbatron").
 * The router writes each route's static `head` title on navigation and the notification bell
 * prefixes a count; this re-applies the title after either and keeps the bell's prefix.
 * `undefined` leaves the route's own title.
 */
export function useDocumentTitle(title: string | undefined) {
  useEffect(() => {
    if (!title) return;
    const apply = () => {
      const prefix = COUNT_PREFIX.exec(document.title)?.[0] ?? "";
      const next = prefix + title;
      if (document.title !== next) document.title = next;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [title]);
}
