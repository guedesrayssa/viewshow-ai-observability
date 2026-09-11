import { ServiceError } from "@view-show/contracts";
import type { ImportControlPort } from "../ports/import-control.js";

export class ImportUseCases {
  constructor(private readonly control: ImportControlPort) {}

  async start(input: {
    fileName: string;
    sizeBytes: number;
    sha256: string;
    partCount: number;
    requestedBy: string;
  }): Promise<never> {
    await this.control.start(input);
    throw unavailable();
  }

  async complete(input: {
    importId: string;
    parts: readonly { partNumber: number; etag: string }[];
    requestedBy: string;
  }): Promise<never> {
    await this.control.complete(input);
    throw unavailable();
  }

  async get(importId: string, requestedBy: string): Promise<never> {
    await this.control.get(importId, requestedBy);
    throw unavailable();
  }
}

function unavailable(): ServiceError {
  return new ServiceError(
    503,
    "FEATURE_UNAVAILABLE",
    "A importação requer S3 e uma tarefa de ingestão configurados.",
  );
}
