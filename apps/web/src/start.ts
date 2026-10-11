import { clerkMiddleware } from "@clerk/tanstack-react-start/server";
import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { type TimeContext, validZone } from "./lib/render-time";

const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

/** One instant and the viewer's time zone (`rh-tz` cookie) per request (lib/render-time.ts). */
const timeMiddleware = createMiddleware().server(({ request, next }) => {
  const cookie = /(?:^|;\s*)rh-tz=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
  const context: TimeContext = {
    renderNow: Date.now(),
    timeZone: validZone(cookie ? decodeURIComponent(cookie) : undefined) ?? "UTC",
  };
  return next({ context });
});

export const startInstance = createStart(() => {
  return {
    requestMiddleware: [csrfMiddleware, clerkMiddleware(), timeMiddleware],
  };
});
