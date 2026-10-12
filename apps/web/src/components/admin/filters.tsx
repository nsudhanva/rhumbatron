import { Button, buttonVariants, cn, Input, Select } from "@cloudflare/kumo";
import { ArrowRight, MagnifyingGlass, X } from "@phosphor-icons/react";
import { Link, type LinkOptions } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useId, useState } from "react";

/**
 * Admin filters. The filters live in the URL search params (each route's `validateSearch`), so a
 * view can be shared and reloaded. A filter bar edits a draft and applies it with "Apply"; the
 * page navigates to the new search. Key the bar by the current search so it restarts from it.
 */

/** Drops empty values, so the URL carries only the filters in use. */
export function cleanSearch<T extends Record<string, unknown>>(search: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(search).filter(([, v]) => v !== undefined && v !== null && v !== ""),
  ) as Partial<T>;
}

/** A string search param, trimmed; undefined when missing, empty or longer than `max`. */
export function stringParam(value: unknown, max = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : undefined;
}

/** A `YYYY-MM-DD` search param. */
export function dateParam(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

/** One of `options`, else undefined. */
export function oneOf<T extends string>(value: unknown, options: readonly T[]): T | undefined {
  return typeof value === "string" && (options as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** The draft of a filter bar, started from the current search. */
export function useDraft<T extends Record<string, unknown>>(search: T) {
  const [draft, setDraft] = useState<T>(search);
  const set = <K extends keyof T>(key: K, value: T[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  return { draft, set };
}

export function FilterBar({
  label,
  onApply,
  onClear,
  active,
  children,
}: {
  label: string;
  onApply: () => void;
  /** Shown only when a filter is set. */
  onClear: () => void;
  active: boolean;
  children: ReactNode;
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onApply();
  };
  return (
    <form aria-label={label} onSubmit={submit} className="flex flex-wrap items-end gap-x-4 gap-y-3">
      {children}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="secondary" icon={MagnifyingGlass}>
          Apply
        </Button>
        {active && (
          <Button type="button" variant="secondary" icon={X} onClick={onClear}>
            Clear filters
          </Button>
        )}
      </div>
    </form>
  );
}
FilterBar.displayName = "FilterBar";

export function TextFilter({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  className,
}: {
  label: string;
  value: string | undefined;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: "text" | "search" | "date";
  className?: string;
}) {
  return (
    <div className={cn("w-[min(240px,100%)]", className)}>
      <Input
        label={label}
        type={type}
        value={value ?? ""}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={cn(type !== "search" && type !== "text" && "font-mono")}
      />
    </div>
  );
}
TextFilter.displayName = "TextFilter";

const ALL = "__all";

export function SelectFilter<T extends string>({
  label,
  value,
  onChange,
  items,
  allLabel,
  className,
}: {
  label: string;
  value: T | undefined;
  onChange: (value: T | undefined) => void;
  items: Record<T, string>;
  /** Label of the "no filter" choice; omit when a value is always set. */
  allLabel?: string;
  className?: string;
}) {
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <span className="text-[12px] text-kumo-subtle" id={id}>
        {label}
      </span>
      <Select
        aria-labelledby={id}
        className={cn("w-[180px]", className)}
        value={value ?? ALL}
        onValueChange={(next) =>
          onChange(typeof next === "string" && next !== ALL ? (next as T) : undefined)
        }
        items={allLabel ? { [ALL]: allLabel, ...items } : items}
      />
    </div>
  );
}
SelectFilter.displayName = "SelectFilter";

/**
 * Cursor paging, newest first: "First page" when the view is not on it, "Next page" while the
 * API returns a cursor. The count line says how many rows this page shows.
 */
export function Pager({
  shown,
  noun,
  first,
  next,
}: {
  shown: number;
  noun: string;
  /** Link to the first page; omit on the first page. */
  first?: LinkOptions | undefined;
  /** Link to the next page; omit on the last page. */
  next?: LinkOptions | undefined;
}) {
  if (!first && !next) {
    return (
      <p className="font-mono text-[12px] text-kumo-subtle tabular-nums">
        {shown} {noun}
      </p>
    );
  }
  return (
    <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <p className="font-mono text-[12px] text-kumo-subtle tabular-nums">
        {shown} {noun} on this page
      </p>
      <div className="flex flex-wrap gap-2">
        {first && (
          <Link {...first} className={buttonVariants({ variant: "secondary", size: "sm" })}>
            First page
          </Link>
        )}
        {next && (
          <Link
            {...next}
            className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "gap-1.5")}
          >
            Next page
            <ArrowRight size={14} aria-hidden />
          </Link>
        )}
      </div>
    </nav>
  );
}
Pager.displayName = "Pager";
