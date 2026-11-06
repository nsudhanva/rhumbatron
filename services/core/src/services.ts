import { createAppsClient } from "../../apps/client.ts";
import { GitServiceClient } from "../../git/client.ts";
import { config } from "./config.ts";

/** Bindings backed by the git, sandboxd and apps services. */
/** Source repositories in the git service: one bare repo per Project, Task fork or Candidate fork. */
export function artifactsBinding(): unknown {
  return new GitServiceClient({
    baseUrl: config.git.baseUrl,
    adminToken: config.git.adminToken,
    namespace: config.git.namespace,
  });
}

export function sandboxBinding(): unknown {
  return { baseUrl: config.sandbox.baseUrl, token: config.sandbox.token };
}

/** The apps service's internal RPC listener: build, check, probe and wipeData. */
export function appsBinding(): unknown {
  return createAppsClient({ url: config.apps.rpcUrl, token: config.apps.token });
}
