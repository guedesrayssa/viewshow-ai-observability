import { UnavailableImportControl } from "./adapters/unavailable-import-control.js";
import { ImportUseCases } from "./application/import-use-cases.js";

export { ImportUseCases } from "./application/import-use-cases.js";
export type { ImportControlPort } from "./ports/import-control.js";

/** Builds the fail-closed imports module until upload and ingestion infrastructure exists. */
export function createImportsModule(): ImportUseCases {
  return new ImportUseCases(new UnavailableImportControl());
}
