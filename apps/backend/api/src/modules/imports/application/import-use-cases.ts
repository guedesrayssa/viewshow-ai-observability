import { randomBytes } from "node:crypto";
import {
  completeImportBodySchema,
  idempotencyKeySchema,
  importIdSchema,
  importsQuerySchema,
  ServiceError,
  signImportPartsBodySchema,
  startImportBodySchema,
  validationError,
  type InternalResponse,
} from "@view-show/contracts";
import type { z } from "zod";
import {
  createImportId,
  importRequestId,
  toPublicImport,
  type ImportRecord,
} from "../domain/import.js";
import type {
  ImportControlPort,
  StartImportInput,
  ImportActionInput,
} from "../ports/import-control.js";
import type { ImportRepository } from "../ports/import-repository.js";
import type {
  ImportUploadStore,
  ImportUploadPart,
} from "../ports/import-upload-store.js";
import {
  DatasetActivationConflictError,
  type DatasetActivationPort,
} from "../ports/dataset-activation.js";
import { InvalidUploadProgressEvidenceError } from "../ports/import-upload-store.js";

const PART_SIZE = 16 * 1024 * 1024;
const UPLOAD_PROGRESS_TTL_MS = 5_000;
const invalid = () =>
  new ServiceError(400, "VALIDATION_ERROR", "Partes da importação inválidas.");
const conflict = () =>
  new ServiceError(
    409,
    "IMPORT_STATE_CONFLICT",
    "Estado da importação incompatível com a operação.",
  );
const unavailable = () =>
  new ServiceError(
    503,
    "DATA_UNAVAILABLE",
    "Não foi possível acessar a importação.",
  );
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw validationError(result.error);
  return result.data;
}
function stateConflict(error: unknown) {
  return (
    error instanceof ServiceError && error.code === "IMPORT_STATE_CONFLICT"
  );
}
function rethrow(error: unknown): never {
  throw error instanceof ServiceError ? error : unavailable();
}

function response<T>(data: T): InternalResponse<T> {
  return {
    data,
    datasetVersion: null,
    quality: {
      window: null,
      partial: false,
      refreshAfterSeconds: null,
      freshness: [],
      warnings: [],
    },
  };
}

export class ImportUseCases implements ImportControlPort {
  private readonly now: () => Date;
  private uploadProgressCache:
    | {
        importId: string;
        uploadGeneration: number;
        key: string;
        uploadId: string;
        completedBytes?: number;
        freshUntil: number;
        pending?: Promise<number>;
      }
    | undefined;
  constructor(
    private readonly repository: ImportRepository,
    private readonly store: ImportUploadStore,
    private readonly options: {
      bucket: string;
      now?: () => Date;
      activation?: DatasetActivationPort;
    },
  ) {
    this.now = options.now ?? (() => new Date());
  }
  async start(input: StartImportInput) {
    const body = parse(startImportBodySchema, {
      fileName: input.fileName,
      sizeBytes: input.sizeBytes,
      snapshotExtractedOn: input.snapshotExtractedOn,
    });
    parse(idempotencyKeySchema, input.idempotencyKey);
    const now = this.now();
    const proposed: ImportRecord = {
      ...body,
      importId: createImportId(now, randomBytes(10)),
      requestedBy: input.requestedBy,
      author: {
        id: input.requestedBy,
        name: input.author?.name ?? null,
        email: input.author?.email ?? null,
      },
      state: "PREPARING",
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      progress: { kind: "none" },
      candidateVersion: null,
      error: null,
      bucket: this.options.bucket,
      key: "",
      uploadId: null,
      taskArn: null,
      physicalVersion: null,
    };
    let record: ImportRecord;
    try {
      record = await this.repository.createAndLock(
        proposed,
        input.idempotencyKey,
      );
    } catch (error) {
      if (
        error instanceof ServiceError &&
        error.code === "IMPORT_IN_PROGRESS"
      ) {
        const active = await this.repository.getActive().catch(() => null);
        if (active)
          throw new ServiceError(
            409,
            "IMPORT_IN_PROGRESS",
            "Já existe uma importação em andamento.",
            undefined,
            { importId: active.importId },
          );
        throw unavailable();
      }
      rethrow(error);
    }
    if (record.importId !== proposed.importId)
      return response(toPublicImport(record, input.requestedBy));
    let upload: { key: string; uploadId: string } | undefined;
    try {
      upload = await this.store.create({
        importId: record.importId,
        fileName: record.fileName,
      });
      record = await this.repository.transition({
        importId: record.importId,
        expectedState: "PREPARING",
        expectedVersion: record.version,
        nextState: "UPLOADING",
        patch: {
          ...upload,
          partSizeBytes: PART_SIZE,
          expectedPartCount: Math.ceil(record.sizeBytes / PART_SIZE),
          uploadGeneration: 1,
          uploadExpiresAt: new Date(
            this.now().getTime() + 86400000,
          ).toISOString(),
          updatedAt: this.now().toISOString(),
          progress: {
            kind: "bytes",
            completedBytes: 0,
            totalBytes: record.sizeBytes,
          },
        },
      });
      return response(toPublicImport(record, input.requestedBy));
    } catch {
      // A write response may be lost after DynamoDB accepted it. Do not abort a committed upload.
      const current = await this.repository
        .get(record.importId)
        .catch(() => null);
      if (
        upload &&
        current?.state === "UPLOADING" &&
        current.uploadId === upload.uploadId
      )
        return response(toPublicImport(current, input.requestedBy));
      // Win the version condition before destroying an upload whose write may still commit.
      // A failed/unknown fence leaves cleanup to lifecycle or reconciliation.
      const released = await this.repository
        .releaseTerminal(record.importId, record.version, "FAILED", {
          updatedAt: this.now().toISOString(),
          error: {
            code: "UPLOAD_PREPARATION_FAILED",
            message: "Não foi possível preparar o envio.",
            requestId: importRequestId(record.importId),
          },
        })
        .catch(() => null);
      if (upload && released)
        await this.store.abort(upload.key, upload.uploadId).catch(() => {});
      throw new ServiceError(
        503,
        "UPLOAD_PREPARATION_FAILED",
        "Não foi possível preparar o envio.",
      );
    }
  }
  private async record(importId: string) {
    parse(importIdSchema, importId);
    const record = await this.repository.get(importId).catch(rethrow);
    if (!record)
      throw new ServiceError(
        404,
        "IMPORT_NOT_FOUND",
        "Importação não encontrada.",
      );
    return record;
  }
  private async owned(importId: string, viewer: string) {
    const record = await this.record(importId);
    if (record.requestedBy !== viewer)
      throw new ServiceError(
        403,
        "IMPORT_NOT_OWNED",
        "Somente o autor pode gerenciar o envio.",
      );
    return record;
  }
  private uploading(record: ImportRecord): asserts record is ImportRecord & {
    uploadId: string;
    partSizeBytes: number;
    expectedPartCount: number;
    uploadGeneration: number;
  } {
    if (record.state !== "UPLOADING") throw conflict();
    if (
      !record.key ||
      !record.uploadId ||
      record.partSizeBytes !== PART_SIZE ||
      record.expectedPartCount !== Math.ceil(record.sizeBytes / PART_SIZE) ||
      !Number.isSafeInteger(record.uploadGeneration) ||
      record.uploadGeneration! < 1
    )
      throw unavailable();
  }
  private parts(
    parts: readonly ImportUploadPart[],
    count: number,
    exact = false,
  ) {
    if (exact && parts.length !== count) throw invalid();
    let previous = 0;
    for (const part of parts) {
      if (
        part.partNumber <= previous ||
        part.partNumber > count ||
        Buffer.from(part.checksumSha256, "base64").toString("base64") !==
          part.checksumSha256
      )
        throw invalid();
      previous = part.partNumber;
    }
  }
  private async confirmedUploadedBytes(record: ImportRecord): Promise<number> {
    this.uploading(record);
    let cache = this.uploadProgressCache;
    if (
      !cache ||
      cache.importId !== record.importId ||
      cache.uploadGeneration !== record.uploadGeneration ||
      cache.key !== record.key ||
      cache.uploadId !== record.uploadId
    ) {
      cache = {
        importId: record.importId,
        uploadGeneration: record.uploadGeneration,
        key: record.key,
        uploadId: record.uploadId,
        freshUntil: 0,
      };
      this.uploadProgressCache = cache;
    }
    const now = this.now().getTime();
    if (cache.completedBytes !== undefined && now < cache.freshUntil)
      return cache.completedBytes;
    if (cache.pending) return cache.pending;

    const previous = cache.completedBytes;
    const pending = this.store
      .getUploadedProgress({
        key: record.key,
        uploadId: record.uploadId,
        expectedSizeBytes: record.sizeBytes,
        expectedPartCount: record.expectedPartCount,
        expectedPartSizeBytes: record.partSizeBytes,
      })
      .then(({ completedBytes }) => {
        if (
          !Number.isSafeInteger(completedBytes) ||
          completedBytes < 0 ||
          completedBytes > record.sizeBytes ||
          (previous !== undefined && completedBytes < previous)
        )
          throw new InvalidUploadProgressEvidenceError();
        if (this.uploadProgressCache === cache) {
          cache.completedBytes = completedBytes;
          cache.freshUntil = this.now().getTime() + UPLOAD_PROGRESS_TTL_MS;
        }
        return completedBytes;
      })
      .catch((error: unknown) => {
        if (
          !(error instanceof InvalidUploadProgressEvidenceError) &&
          !(
            error instanceof ServiceError && error.code === "VALIDATION_ERROR"
          ) &&
          previous !== undefined
        )
          return previous;
        throw unavailable();
      })
      .finally(() => {
        if (this.uploadProgressCache === cache && cache.pending === pending)
          delete cache.pending;
      });
    cache.pending = pending;
    return pending;
  }
  private async publicRecord(record: ImportRecord, requestedBy: string) {
    if (record.state !== "UPLOADING")
      return toPublicImport(record, requestedBy);
    const completedBytes = await this.confirmedUploadedBytes(record);
    return toPublicImport(
      {
        ...record,
        progress: {
          kind: "bytes",
          completedBytes,
          totalBytes: record.sizeBytes,
        },
      },
      requestedBy,
    );
  }
  async get(importId: string, requestedBy: string) {
    return response(
      await this.publicRecord(await this.record(importId), requestedBy),
    );
  }
  async list(input: Parameters<ImportControlPort["list"]>[0]) {
    const query = parse(importsQuerySchema, {
      limit: input.limit,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    });
    const page = await this.repository
      .list({
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      })
      .catch(rethrow);
    const uploading = page.items.find((record) => record.state === "UPLOADING");
    const uploadedBytes = uploading
      ? await this.confirmedUploadedBytes(uploading)
      : undefined;
    const activeDatasetVersion = this.options.activation
      ? await this.options.activation.getActiveVersion().catch(rethrow)
      : null;
    return response({
      items: page.items.map((record) => {
        if (record !== uploading || uploadedBytes === undefined)
          return toPublicImport(record, input.requestedBy);
        return toPublicImport(
          {
            ...record,
            progress: {
              kind: "bytes",
              completedBytes: uploadedBytes,
              totalBytes: record.sizeBytes,
            },
          },
          input.requestedBy,
        );
      }),
      cursor: page.cursor ?? null,
      ...(this.options.activation ? { activeDatasetVersion } : {}),
    });
  }

  async activate(input: ImportActionInput) {
    parse(idempotencyKeySchema, input.idempotencyKey);
    const record = await this.record(input.importId);
    if (record.state !== "READY" || !record.candidateVersion) throw conflict();
    if (!this.options.activation) throw unavailable();
    let result;
    try {
      result = await this.options.activation.activate({
        importId: record.importId,
        candidateVersion: record.candidateVersion,
        requestedBy: input.requestedBy,
        idempotencyKey: input.idempotencyKey,
        activatedAt: this.now().toISOString(),
      });
    } catch (error) {
      if (error instanceof DatasetActivationConflictError)
        throw new ServiceError(
          409,
          "CONFLICT",
          "O dataset ativo mudou durante a ativação. Atualize a página e tente novamente.",
        );
      rethrow(error);
    }
    return response(result);
  }
  async listParts(importId: string, requestedBy: string) {
    const record = await this.owned(importId, requestedBy);
    this.uploading(record);
    return response({
      parts: [
        ...(await this.store
          .listParts({ key: record.key, uploadId: record.uploadId })
          .catch(rethrow)),
      ],
    });
  }
  async signParts(input: Parameters<ImportControlPort["signParts"]>[0]) {
    const record = await this.owned(input.importId, input.requestedBy);
    this.uploading(record);
    const { parts } = parse(signImportPartsBodySchema, { parts: input.parts });
    this.parts(parts, record.expectedPartCount);
    const expiresAt = new Date(this.now().getTime() + 900000).toISOString();
    const signed = await this.store
      .signParts({ key: record.key, uploadId: record.uploadId, parts })
      .catch(rethrow);
    return response({
      parts: signed.map((part) => ({
        ...part,
        headers: { ...part.headers },
        expiresAt,
      })),
    });
  }
  async restart(input: ImportActionInput) {
    parse(idempotencyKeySchema, input.idempotencyKey);
    const record = await this.owned(input.importId, input.requestedBy);
    const replay = await this.repository
      .getRestartReplay(record.importId, input.idempotencyKey)
      .catch(rethrow);
    if (replay) return response(toPublicImport(replay, input.requestedBy));
    this.uploading(record);
    if (record.completionRequestedAt) throw conflict();
    const upload = await this.store
      .create({ importId: record.importId, fileName: record.fileName })
      .catch(rethrow);
    let updated: ImportRecord;
    try {
      updated = await this.repository.swapUploadForRestart(
        {
          importId: record.importId,
          expectedState: "UPLOADING",
          expectedVersion: record.version,
          patch: {
            ...upload,
            uploadGeneration: record.uploadGeneration + 1,
            updatedAt: this.now().toISOString(),
            progress: {
              kind: "bytes",
              completedBytes: 0,
              totalBytes: record.sizeBytes,
            },
          },
        },
        input.idempotencyKey,
      );
    } catch (error) {
      const current = await this.repository
        .get(record.importId)
        .catch(() => null);
      if (current?.uploadId === upload.uploadId) {
        await this.store.abort(record.key, record.uploadId).catch(() => {});
        return response(toPublicImport(current, input.requestedBy));
      }
      // Only a rejected CAS or a newer durable version rules out adoption by this write.
      if (stateConflict(error) || (current && current.version > record.version))
        await this.store.abort(upload.key, upload.uploadId).catch(() => {});
      if (stateConflict(error) && current) {
        const recorded = await this.repository
          .recordRestartReplay(
            record.importId,
            current.version,
            input.idempotencyKey,
          )
          .catch(() => {
            throw unavailable();
          });
        return response(toPublicImport(recorded, input.requestedBy));
      }
      rethrow(error);
    }
    await this.store.abort(record.key, record.uploadId).catch(() => {});
    return response(toPublicImport(updated, input.requestedBy));
  }
  async complete(input: Parameters<ImportControlPort["complete"]>[0]) {
    parse(idempotencyKeySchema, input.idempotencyKey);
    let record = await this.record(input.importId);
    const completedStates: readonly ImportRecord["state"][] = [
      "UPLOADED",
      "VALIDATING",
      "PROCESSING",
      "READY",
    ];
    const isCompletionSettled = (candidate: ImportRecord) =>
      completedStates.includes(candidate.state) ||
      (candidate.state === "FAILED" &&
        candidate.completionRequestedAt !== undefined &&
        Number.isSafeInteger(candidate.uploadGeneration) &&
        candidate.uploadGeneration! >= 1 &&
        candidate.completionUploadGeneration === candidate.uploadGeneration);
    if (record.state !== "UPLOADING" && !isCompletionSettled(record)) {
      if (record.requestedBy !== input.requestedBy)
        throw new ServiceError(
          403,
          "IMPORT_NOT_OWNED",
          "Somente o autor pode gerenciar o envio.",
        );
      throw conflict();
    }
    if (
      !Number.isSafeInteger(record.uploadGeneration) ||
      record.uploadGeneration! < 1 ||
      !Number.isSafeInteger(record.expectedPartCount) ||
      record.expectedPartCount! < 1
    )
      throw unavailable();
    const { parts } = parse(completeImportBodySchema, { parts: input.parts });
    this.parts(parts, record.expectedPartCount!, true);
    const replayInput = {
      idempotencyKey: input.idempotencyKey,
      uploadGeneration: record.uploadGeneration!,
      requestedBy: input.requestedBy,
      parts,
    };
    const replay = await this.repository
      .getCompletionReplay(record.importId, replayInput)
      .catch(rethrow);
    if (replay) record = replay;
    if (record.requestedBy !== input.requestedBy)
      throw new ServiceError(
        403,
        "IMPORT_NOT_OWNED",
        "Somente o autor pode gerenciar o envio.",
      );
    if (isCompletionSettled(record)) {
      if (!replay)
        record = await this.repository
          .recordCompletionReplay(record.importId, replayInput)
          .catch(rethrow);
      return response(toPublicImport(record, input.requestedBy));
    }
    this.uploading(record);
    const recovering = record.completionRequestedAt !== undefined;
    if (!replay && !recovering) {
      record = await this.repository
        .beginCompletion(
          {
            importId: record.importId,
            expectedState: "UPLOADING",
            expectedVersion: record.version,
            patch: {
              completionRequestedAt: this.now().toISOString(),
              completionUploadGeneration: record.uploadGeneration,
              updatedAt: this.now().toISOString(),
            },
          },
          replayInput,
        )
        .catch(rethrow);
    } else if (!replay) {
      record = await this.repository
        .recordCompletionReplay(record.importId, replayInput)
        .catch(rethrow);
    }
    if (isCompletionSettled(record))
      return response(toPublicImport(record, input.requestedBy));
    this.uploading(record);
    if (record.completionUploadGeneration !== record.uploadGeneration)
      throw conflict();
    try {
      let completed = recovering
        ? await this.store.recoverCompleted(record.key, record.sizeBytes)
        : null;
      if (!completed) {
        try {
          completed = await this.store.complete({
            key: record.key,
            uploadId: record.uploadId,
            parts,
            expectedSizeBytes: record.sizeBytes,
            expectedPartCount: record.expectedPartCount,
          });
        } catch (error) {
          if (!(error instanceof Error) || error.name !== "NoSuchUpload")
            throw error;
          completed = await this.store.recoverCompleted(
            record.key,
            record.sizeBytes,
          );
          if (!completed) throw error;
        }
      }
      const { versionId } = completed;
      await this.store.head(record.key, versionId, record.sizeBytes);
      const updated = await this.repository.transition({
        importId: record.importId,
        expectedState: "UPLOADING",
        expectedVersion: record.version,
        nextState: "UPLOADED",
        patch: {
          physicalVersion: versionId,
          updatedAt: this.now().toISOString(),
          progress: {
            kind: "bytes",
            completedBytes: record.sizeBytes,
            totalBytes: record.sizeBytes,
          },
        },
      });
      return response(toPublicImport(updated, input.requestedBy));
    } catch (error) {
      const current = await this.repository
        .get(record.importId)
        .catch(() => null);
      if (
        current &&
        ["UPLOADED", "VALIDATING", "PROCESSING", "READY"].includes(
          current.state,
        )
      )
        return response(toPublicImport(current, input.requestedBy));
      rethrow(error);
    }
  }
}
