import { SESSION_IDLE_MS } from "../../lib/api-code-session";

/** One open file in the session editor. `saved` is the content the fork holds. */
export type IdeTab = {
  path: string;
  state: "loading" | "ready" | "error";
  saved: string;
  draft: string;
  /** Why the file did not open (binary, too large, gone). */
  error?: string | undefined;
  saving?: boolean | undefined;
  saveError?: string | undefined;
};

export const isDirty = (tab: IdeTab) => tab.state === "ready" && tab.draft !== tab.saved;

/** Session warns this long before it ends. */
export const EXPIRY_WARNING_MS = 60 * 1000;

/**
 * When the session ends: 10 minutes after the last request the web made, and never after the
 * 2-hour limit (`hardExpiresAt`), whichever comes first.
 */
export function sessionDeadline(lastRequestAt: number, hardExpiresAt: string | undefined): number {
  const idle = lastRequestAt + SESSION_IDLE_MS;
  const hard = hardExpiresAt ? Date.parse(hardExpiresAt) : Number.NaN;
  return Number.isFinite(hard) ? Math.min(idle, hard) : idle;
}

/** `9:05`, `0:42`: minutes and seconds left, never negative. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Why a path cannot be written, or null when it can (the API rules: under the repo root, no
 * `..`, no `.git` part).
 */
export function pathProblem(path: string): string | null {
  if (!path) return "Enter a path.";
  if (path.length > 1024) return "Use a path of 1,024 characters or fewer.";
  if (path.startsWith("/")) return "Use a path under the repository root, without a leading /.";
  if (path.endsWith("/")) return "End the path with a file name.";
  const parts = path.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".."))
    return "Remove empty, . and .. parts from the path.";
  if (parts.some((p) => p.toLowerCase() === ".git")) return "Paths with a .git part cannot change.";
  return null;
}

/** The directory of a path with a trailing slash, or "" at the root. */
export function dirOf(path: string | null | undefined): string {
  if (!path) return "";
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at + 1);
}

/** Every parent directory of a path (`a`, `a/b` for `a/b/c.ts`). */
export function parentDirs(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** Byte length of text as the API counts it (UTF-8). */
export const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** Every query word appears in the path (quick open). Shorter paths first. */
export function matchPaths(paths: string[], query: string, limit: number): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = words.length
    ? paths.filter((p) => {
        const lower = p.toLowerCase();
        return words.every((w) => lower.includes(w));
      })
    : paths;
  return [...hits].sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, limit);
}
