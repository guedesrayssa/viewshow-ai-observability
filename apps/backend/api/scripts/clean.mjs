import { rm } from "node:fs/promises";

for (const directory of ["dist", "contracts/dist", "incidents-service/dist", "dashboard-query-service/dist", "identity-service/dist", "runtime-compat/dist"]) {
  await rm(new URL(`../${directory}`, import.meta.url), { recursive: true, force: true });
}
