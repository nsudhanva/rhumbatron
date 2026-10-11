import { createIsomorphicFn, getGlobalStartContext } from "@tanstack/react-start";

/**
 * Time values that the server render and the client hydration must agree on.
 *
 * Signed-in pages render their data on the server (lib/ssr-data.ts). Clock times depend on the
 * viewer's time zone and relative ages on the current instant, so a server render in UTC, or a
 * few seconds earlier than hydration, would print other text than the client and fail hydration.
 *
 * - Time zone: `TIME_ZONE_BOOT_SCRIPT` stores the browser's zone in the `rh-tz` cookie. The
 *   server formats clock times in that zone (UTC on a first visit without the cookie) and writes
 *   it to `<html data-tz>`. The client formats in the same zone for the life of the page.
 * - Instant: the server takes one instant per request and writes it to `<html data-now>`. While
 *   the page hydrates, the client uses that instant. After hydration it uses the real clock.
 */

/** Runs in <head>: keeps the `rh-tz` cookie equal to the browser's time zone for the next render. */
export const TIME_ZONE_BOOT_SCRIPT = `(function(){try{var z=Intl.DateTimeFormat().resolvedOptions().timeZone;if(z&&document.cookie.indexOf("rh-tz="+encodeURIComponent(z))<0)document.cookie="rh-tz="+encodeURIComponent(z)+";path=/;max-age=31536000;samesite=lax;secure"}catch(e){}})();`;

/** Request context fields set by `timeMiddleware` (start.ts). */
export type TimeContext = { renderNow: number; timeZone: string };

/** The zone if this runtime knows it, else undefined. */
export function validZone(zone: string | undefined): string | undefined {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

function serverTime(): TimeContext | undefined {
  try {
    return getGlobalStartContext() as Partial<TimeContext> as TimeContext | undefined;
  } catch {
    // Outside a request (module evaluation): no request time.
    return undefined;
  }
}

let hydrated = false;

/** Called once the page has hydrated (root route): from then on `renderNow` reads the clock. */
export function markHydrated(): void {
  hydrated = true;
}

/** The time zone clock times are shown in. Undefined means the runtime's own zone. */
export const displayTimeZone = createIsomorphicFn()
  .server((): string | undefined => serverTime()?.timeZone ?? "UTC")
  .client((): string | undefined => validZone(document.documentElement.dataset.tz));

/** "Now" for anything a render prints: the request instant until the page has hydrated. */
export const renderNow = createIsomorphicFn()
  .server((): number => serverTime()?.renderNow ?? Date.now())
  .client((): number => {
    if (hydrated) return Date.now();
    const at = Number(document.documentElement.dataset.now);
    return Number.isFinite(at) && at > 0 ? at : Date.now();
  });

/**
 * Offset of the display zone from UTC at instant `t`, in milliseconds (positive east of UTC).
 * Time axes use it to put ticks on the viewer's whole minutes and hours.
 */
export function zoneOffsetMs(t: number): number {
  const timeZone = displayTimeZone();
  if (!timeZone) return -new Date(t).getTimezoneOffset() * 60_000;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(t));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wall = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  return wall - Math.floor(t / 1000) * 1000;
}
