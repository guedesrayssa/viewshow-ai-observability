import type {
  CompleteImportBody,
  ImportAuthor,
  InternalResponse,
  ImportPage,
  ImportPartsResponse,
  ImportSnapshot,
  SignImportPartsBody,
  SignImportPartsResponse,
  StartImportBody,
} from "@view-show/contracts";
import type { DatasetActivationResult } from "./dataset-activation.js";

export type StartImportInput = StartImportBody & {
  requestedBy: string;
  idempotencyKey: string;
  author?: ImportAuthor;
};
export type ImportActionInput = {
  importId: string;
  requestedBy: string;
  idempotencyKey: string;
};
export interface ImportControlPort {
  start(input: StartImportInput): Promise<InternalResponse<ImportSnapshot>>;
  get(
    importId: string,
    requestedBy: string,
  ): Promise<InternalResponse<ImportSnapshot>>;
  list(input: {
    requestedBy: string;
    limit: number;
    cursor?: string | undefined;
  }): Promise<InternalResponse<ImportPage>>;
  listParts(
    importId: string,
    requestedBy: string,
  ): Promise<InternalResponse<ImportPartsResponse>>;
  signParts(
    input: SignImportPartsBody & { importId: string; requestedBy: string },
  ): Promise<InternalResponse<SignImportPartsResponse>>;
  restart(input: ImportActionInput): Promise<InternalResponse<ImportSnapshot>>;
  complete(
    input: CompleteImportBody & ImportActionInput,
  ): Promise<InternalResponse<ImportSnapshot>>;
  activate(
    input: ImportActionInput,
  ): Promise<InternalResponse<DatasetActivationResult>>;
}
