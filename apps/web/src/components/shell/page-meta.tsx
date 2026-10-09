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
