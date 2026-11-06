import { config } from "./config.ts";

/** The browser binding: the Playwright server that browser checks connect to. */
export function browserBinding(): { wsEndpoint: string } {
  return { wsEndpoint: config.browserWsUrl };
}
