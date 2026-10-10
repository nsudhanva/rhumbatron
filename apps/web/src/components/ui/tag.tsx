import { cn } from "@cloudflare/kumo";
import type { ReactNode } from "react";

const VARIANTS = {
  accent: "bg-kumo-info-tint text-kumo-info",
  neutral: "bg-tone-200 text-tone-800",
  outline: "border border-kumo-line text-kumo-default",
} as const;

export type TagVariant = keyof typeof VARIANTS;

/**
 * Descriptive tag, not a status: 12px, 2 x 8px, 6px radius, no icon (a status pill always has
 * one). Use `outline` for qualifiers such as "High risk" or a variant label on a card.
 *
 *   <Tag variant="outline">High risk</Tag>
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
        "inline-flex w-fit shrink-0 items-center rounded-md px-2 py-0.5 text-[12px] leading-4 whitespace-nowrap",
        VARIANTS[variant],
        variant === "outline" && "py-[1px]",
        className,
      )}
    >
      {children}
    </span>
  );
}
Tag.displayName = "Tag";
