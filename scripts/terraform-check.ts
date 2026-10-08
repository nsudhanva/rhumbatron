/**
 * Static Terraform checks for every root. Never touches remote state or creates resources.
 */
import { resolve } from "node:path";
import { $ } from "bun";

const tfRoot = resolve(import.meta.dir, "../infrastructure/terraform");
const roots = ["bootstrap", "envs/dev", "envs/prod"];

await $`terraform fmt -check -recursive ${tfRoot}`;

for (const dir of roots) {
  const cwd = resolve(tfRoot, dir);
  console.log(`\n== ${dir}`);
  await $`terraform init -backend=false -input=false -no-color`.cwd(cwd).quiet();
  await $`terraform validate -no-color`.cwd(cwd);
  await $`tflint --init --config=${tfRoot}/.tflint.hcl`.cwd(cwd).quiet();
  await $`tflint --config=${tfRoot}/.tflint.hcl --recursive --no-color`.cwd(cwd);
}

// Modules are not called from any root yet, so validate them directly.
for (const module of ["modules/worker"]) {
  const cwd = resolve(tfRoot, module);
  console.log(`\n== ${module}`);
  await $`terraform init -backend=false -input=false -no-color`.cwd(cwd).quiet();
  await $`terraform validate -no-color`.cwd(cwd);
  await $`tflint --config=${tfRoot}/.tflint.hcl --no-color`.cwd(cwd);
}
console.log("\nTerraform checks passed.");
