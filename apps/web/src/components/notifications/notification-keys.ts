/** React Query keys and small formatters shared by the bell and the lazily loaded inbox. */
export const NOTIFICATION_KEYS = {
  all: ["notifications"] as const,
  count: ["notifications", "count"] as const,
  list: ["notifications", "list"] as const,
};

/** Badge and tab-title count: `99+` above 99, so the badge keeps its width. */
export const formatBadge = (n: number) => (n > 99 ? "99+" : String(n));

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
