import { cn } from "@cloudflare/kumo";
import type { ReactNode } from "react";

const VARIANTS = {
  accent: "bg-accent-100 text-accent-800",
  neutral: "bg-tone-100 text-tone-800",
  outline: "border border-accent-500 text-kumo-accent",
} as const;

export type TagVariant = keyof typeof VARIANTS;

/**
 * Descriptive tag, not a status: 11px, +0.02em, 3 x 10px, square.
 * Use `outline` for qualifiers such as "Risk high" or a variant label on a card.
 *
 *   <Tag variant="outline">Risk high</Tag>
 */
export function Tag({
  variant = "neutral",
  className,
  children,
}: {
  variant?: TagVariant;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex w-fit shrink-0 items-center px-2.5 py-[3px] text-[11px] leading-tight tracking-[0.02em] whitespace-nowrap",
        VARIANTS[variant],
        variant === "outline" && "py-[2px]",
        className,
      )}
    >
      {children}
    </span>
  );
}
Tag.displayName = "Tag";
