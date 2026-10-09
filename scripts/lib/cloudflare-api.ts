/** Minimal Cloudflare API client for the Terraform-invoked adapters (AGENTS.md section 11.4). */

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}.`);
    process.exit(2);
  }
  return value;
}

/** Adapters may only run from terraform apply. */
export function assertInvokedByTerraform(script: string) {
  if (process.env.RHUMBATRON_INVOKED_BY !== "terraform") {
    console.error(`${script} runs only from terraform apply. See AGENTS.md section 11.4.`);
    process.exit(2);
  }
}

type ApiEnvelope<T> = {
  success: boolean;
  errors?: { code?: number; message: string }[];
  result: T;
};

export async function cfApi<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  const body = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || !body.success) {
    const message = body.errors?.map((e) => `${e.code ?? ""} ${e.message}`.trim()).join("; ");
    throw new Error(
      `${init.method ?? "GET"} ${new URL(url).pathname} failed: ${message || response.status}`,
    );
  }
  return body.result;
}

/** Multipart variant of cfApi (script uploads). fetch sets the multipart boundary header. */
export async function cfApiForm<T>(
  token: string,
  url: string,
  form: FormData,
  method = "PUT",
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const body = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || !body.success) {
    const message = body.errors?.map((e) => `${e.code ?? ""} ${e.message}`.trim()).join("; ");
    throw new Error(`${method} ${new URL(url).pathname} failed: ${message || response.status}`);
  }
  return body.result;
}
