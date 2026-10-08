/**
 * Static Terraform checks for every root. Never touches remote state or creates resources.
 */
import { resolve } from "node:path";
import { $ } from "bun";

const tfRoot = resolve(import.meta.dir, "../infrastructure/terraform");

// A separate data directory keeps these checks away from the real R2 backend, and blank
// credentials stop the S3 backend from falling back to ambient AWS credentials.
const offlineEnv = (dir: string) => ({
  ...process.env,
  TF_DATA_DIR: resolve(tfRoot, ".terraform-check", dir.replaceAll("/", "-")),
  AWS_ACCESS_KEY_ID: "",
  AWS_SECRET_ACCESS_KEY: "",
  AWS_PROFILE: "",
});
const roots = ["bootstrap", "envs/global", "envs/dev", "envs/prod"];

await $`terraform fmt -check -recursive ${tfRoot}`;

for (const dir of roots) {
  const cwd = resolve(tfRoot, dir);
  console.log(`\n== ${dir}`);
  const env = offlineEnv(dir);
  await $`terraform init -backend=false -input=false -no-color`.cwd(cwd).env(env).quiet();
  await $`terraform validate -no-color`.cwd(cwd).env(env);
  await $`tflint --init --config=${tfRoot}/.tflint.hcl`.cwd(cwd).quiet();
  await $`tflint --config=${tfRoot}/.tflint.hcl --recursive --no-color`.cwd(cwd);
}

// The worker module is not called from any root yet, so validate it directly.
for (const module of ["modules/worker"]) {
  const cwd = resolve(tfRoot, module);
  console.log(`\n== ${module}`);
  const env = offlineEnv(module);
  await $`terraform init -backend=false -input=false -no-color`.cwd(cwd).env(env).quiet();
  await $`terraform validate -no-color`.cwd(cwd).env(env);
  await $`tflint --config=${tfRoot}/.tflint.hcl --no-color`.cwd(cwd);
}
console.log("\nTerraform checks passed.");
