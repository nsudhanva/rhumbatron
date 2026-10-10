/**
 * Inbox loading state (DESIGN.md 8.5 skeleton): the real header and rows under real rules, with
 * recessed lines at the text heights they replace. Shown while the inbox chunk or list loads.
 */
export function InboxSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading notifications">
      <div className="flex h-11 items-center border-b-2 border-kumo-divider px-3">
        <span className="type-h6">Notifications</span>
      </div>
      <ul>
        {Array.from({ length: rows }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
          <li key={i} className="grid gap-1.5 border-b border-kumo-rule px-3 py-3">
            <span aria-hidden className="skeleton-line block h-[13px] w-3/5" />
            <span aria-hidden className="skeleton-line block h-[11px] w-4/5" />
          </li>
        ))}
      </ul>
    </div>
  );
}
InboxSkeleton.displayName = "InboxSkeleton";
