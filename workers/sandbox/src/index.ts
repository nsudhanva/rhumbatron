/**
 * Hosts the Sandbox container class (ADR 0012). Agents reach it through a cross-script Durable
 * Object binding; this Worker serves no traffic of its own.
 */
export { Sandbox } from "@cloudflare/sandbox";

export default {
  async fetch(): Promise<Response> {
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler;
