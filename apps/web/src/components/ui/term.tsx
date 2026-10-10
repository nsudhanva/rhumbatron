import { cn, Tooltip } from "@cloudflare/kumo";
import { Question } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { GLOSSARY, type GlossaryKey, glossaryHint } from "../../lib/glossary";

/**
 * A plain-language label with a small "?" glossary tooltip (docs/ux/research-2026-10-09.md
 * section 7.6). Use it the first time a renamed concept appears on a page:
 *
 *   <Term k="version" />                 -> "Version" + ? tooltip
 *   <Term k="version">Version B</Term>   -> custom text, same tooltip
 *   <Term k="release" plain />           -> label only, no icon (dense rows)
 *
 * The tooltip holds the one-sentence hint and the internal name, so developers can map the
 * label back to AGENTS.md section 3. The icon button has an accessible name.
 */
export function Term({
  k,
  children,
  plain = false,
  className,
}: {
  k: GlossaryKey;
  children?: ReactNode;
  plain?: boolean;
  className?: string;
}) {
  const entry = GLOSSARY[k];
  const text = children ?? entry.label;
  if (plain) return <span className={className}>{text}</span>;
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {text}
      <Tooltip
        content={glossaryHint(k)}
        render={
          <button
            type="button"
            aria-label={`What is ${entry.label}?`}
            className="inline-grid size-4 place-items-center text-kumo-subtle hover:text-kumo-default focus-visible:outline-2"
          >
            <Question size={14} aria-hidden />
          </button>
        }
      />
    </span>
  );
}
Term.displayName = "Term";

/** The glossary hint alone, for a `title` attribute or a help line. */
export const termHint = glossaryHint;
