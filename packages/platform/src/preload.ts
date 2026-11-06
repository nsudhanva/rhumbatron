import { plugin } from "bun";
import { installWebSocketGlobals } from "./actors/websocket.ts";
import * as runtime from "./runtime-module.ts";

/**
 * Loaded with `bun --preload`. It maps the runtime module specifiers that application code and
 * its libraries import to this platform's implementations, before any of that code loads.
 */

installWebSocketGlobals();

plugin({
  name: "rhumbatron-platform",
  setup(build) {
    build.module("cloudflare:workers", () => ({ exports: runtime, loader: "object" }));
    build.module("cloudflare:email", () => ({
      exports: {
        EmailMessage: class EmailMessage {
          constructor() {
            throw new Error("Email is not available on this platform");
          }
        },
      },
      loader: "object",
    }));
  },
});
