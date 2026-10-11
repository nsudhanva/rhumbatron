/**
 * Clerk's browser scripts (clerk-js, @clerk/ui and Clerk's bot protection, about 400 kB) run
 * long tasks on load. A signed-out visitor on a page with no Clerk UI does not need them until
 * they act, so their load waits for the first sign of intent: pointer, touch, key or focus.
 *
 * Mechanism: Clerk's loader waits for an existing `script[data-clerk-js-script]` element before
 * it adds its own. A placeholder element with that attribute (and no source) holds the load.
 * {@link loadClerk} fires `error` on the placeholder and removes it, so Clerk's loader adds the
 * real script the same way it always does. If nothing happens, Clerk's own 15 s script timeout
 * ends the wait and Clerk loads anyway.
 *
 * Clerk loads at once when the server saw a session, when a Clerk cookie or URL parameter
 * suggests one, and on the sign-in and sign-up pages.
 */

const INTENT_EVENTS = ["pointerover", "pointerdown", "touchstart", "keydown", "focusin"] as const;

let placeholder: HTMLScriptElement | null = null;

type ClerkInitWindow = Window & {
  __clerk_init_state?: {
    __internal_clerk_state?: { __clerk_ssr_state?: { userId?: string | null } };
  };
};

function serverSawSignedOut(): boolean {
  const ssr = (window as ClerkInitWindow).__clerk_init_state?.__internal_clerk_state
    ?.__clerk_ssr_state;
  return ssr !== undefined && !ssr.userId;
}

function mayHaveSession(): boolean {
  if ([...new URLSearchParams(location.search).keys()].some((key) => key.startsWith("__clerk"))) {
    return true;
  }
  return document.cookie
    .split(";")
    .some((part) => /^\s*__client_uat(_[^=]+)?=/.test(part) && !/=\s*0?\s*$/.test(part));
}

function pageShowsClerkUi(): boolean {
  return /^\/sign-(in|up)(\/|$)/.test(location.pathname);
}

/** Starts the Clerk load now if it is waiting. Safe to call at any time and more than once. */
export function loadClerk(): void {
  const held = placeholder;
  if (!held) return;
  placeholder = null;
  for (const type of INTENT_EVENTS) removeEventListener(type, loadClerk, true);
  held.dispatchEvent(new Event("error"));
  held.remove();
}

/** Holds Clerk's script load for a signed-out visitor. Call before hydration. */
export function deferClerkForSignedOutVisitors(): void {
  if (!serverSawSignedOut() || mayHaveSession() || pageShowsClerkUi()) return;
  const held = document.createElement("script");
  held.type = "text/plain";
  held.setAttribute("data-clerk-js-script", "");
  document.head.appendChild(held);
  placeholder = held;
  for (const type of INTENT_EVENTS) {
    addEventListener(type, loadClerk, { capture: true, passive: true });
  }
}
