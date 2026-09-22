export type DatasetActivationInput = Readonly<{
  importId: string;
  candidateVersion: string;
  requestedBy: string;
  idempotencyKey: string;
  activatedAt: string;
}>;

export type DatasetActivationResult = Readonly<{
  importId: string;
  datasetVersion: string;
  activatedAt: string;
  activatedBy: string;
  changed: boolean;
}>;

export interface DatasetActivationPort {
  getActiveVersion(): Promise<string | null>;
  activate(input: DatasetActivationInput): Promise<DatasetActivationResult>;
}

export class DatasetActivationContractError extends Error {
  constructor() {
    super("The candidate dataset manifest is not ready for activation.");
    this.name = "DatasetActivationContractError";
  }
}

export class DatasetActivationConflictError extends Error {
  constructor() {
    super("The active dataset changed while the candidate was activated.");
    this.name = "DatasetActivationConflictError";
  }
}
