import {
  createLogger,
  importTimestampSchema,
  type Logger,
} from "@view-show/contracts";
import {
  decodeImportPipelineVersion,
  importRequestId,
  isActiveImportState,
  type ImportRecord,
} from "../domain/import.js";
import type { ImportRepository } from "../ports/import-repository.js";
import type { ImportUploadStore } from "../ports/import-upload-store.js";
import type { ImportWorkerLauncher } from "../ports/import-worker-launcher.js";

const LEASE_SECONDS = 45;
const PREPARING_TIMEOUT_MS = 5 * 60 * 1_000;
const TICK_MS = 60 * 1_000;
const WORKER_STATES = new Set(["UPLOADED", "VALIDATING", "PROCESSING"]);

function reconciliationErrorCategory(
  error: unknown,
): "AWS_ERROR" | "ERROR" | "UNKNOWN" {
  if (typeof error === "object" && error !== null && "$metadata" in error)
    return "AWS_ERROR";
  if (error instanceof Error) return "ERROR";
  return "UNKNOWN";
}

interface TimerHandle {
  unref(): void;
}

interface ImportReconcilerOptions {
  readonly owner: string;
  readonly canonicalFirstEnabled?: boolean;
  readonly now?: () => Date;
  readonly logger?: Logger;
  readonly setInterval?: (
    callback: () => void,
    milliseconds: number,
  ) => TimerHandle;
  readonly clearInterval?: (timer: TimerHandle) => void;
}

const defaultSetInterval = (
  callback: () => void,
  milliseconds: number,
): TimerHandle => setInterval(callback, milliseconds);
const defaultClearInterval = (timer: TimerHandle): void =>
  clearInterval(timer as NodeJS.Timeout);

export class ImportReconciler {
  private readonly now: () => Date;
  private readonly logger: Logger;
  private readonly setIntervalFn: NonNullable<
    ImportReconcilerOptions["setInterval"]
  >;
  private readonly clearIntervalFn: NonNullable<
    ImportReconcilerOptions["clearInterval"]
  >;
  private timer: TimerHandle | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly repository: ImportRepository,
    private readonly store: ImportUploadStore,
    private readonly launcher: ImportWorkerLauncher,
    private readonly options: ImportReconcilerOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? createLogger("view-show-api");
    this.setIntervalFn = options.setInterval ?? defaultSetInterval;
    this.clearIntervalFn = options.clearInterval ?? defaultClearInterval;
  }

  async reconcile(now = this.now()): Promise<void> {
    const nowEpochSeconds = Math.floor(now.getTime() / 1_000);
    const acquired = await this.repository.tryAcquireReconcileLease({
      owner: this.options.owner,
      nowEpochSeconds,
      expiresAtEpochSeconds: nowEpochSeconds + LEASE_SECONDS,
    });
    if (!acquired) return;

    try {
      const active = await this.repository.getActive();
      if (!active) return;
      await this.reconcileActive(active, now);
    } finally {
      await this.repository.releaseReconcileLease(this.options.owner);
    }
  }

  private async reconcileActive(
    record: ImportRecord,
    now: Date,
  ): Promise<void> {
    if (!isActiveImportState(record.state)) {
      await this.repository.clearActiveLock(record.importId);
      return;
    }

    if (record.state === "UPLOADING") {
      this.logger.info("import active upload age", {
        event: "import_active_upload_age",
        active_upload_age_seconds: Math.max(
          0,
          Math.floor((now.getTime() - Date.parse(record.createdAt)) / 1_000),
        ),
        state: "UPLOADING",
      });
    }

    if (
      record.state === "PREPARING" &&
      now.getTime() - Date.parse(record.createdAt) >= PREPARING_TIMEOUT_MS
    ) {
      await this.fail(record, now, {
        code: "UPLOAD_PREPARATION_FAILED",
        message: "Não foi possível preparar o envio.",
      });
      return;
    }

    if (record.state === "UPLOADING") {
      const recovered = await this.recoverUpload(record, now);
      if (!recovered) return;
      record = recovered;
    }

    if (!WORKER_STATES.has(record.state)) return;
    if (!record.taskArn) {
      if (
        record.pipelineVersion === undefined &&
        record.state !== "PROCESSING"
      ) {
        record = await this.repository.reservePipeline({
          importId: record.importId,
          expectedVersion: record.version,
          pipelineVersion: this.options.canonicalFirstEnabled
            ? "canonical-v2"
            : "legacy-v1",
          updatedAt: now.toISOString(),
        });
      }
      const launched = await this.launcher.launch(
        record.importId,
        decodeImportPipelineVersion(record.pipelineVersion),
      );
      await this.repository.patch({
        importId: record.importId,
        expectedState: record.state,
        expectedVersion: record.version,
        patch: { taskArn: launched.taskArn, updatedAt: now.toISOString() },
      });
      return;
    }

    const status = await this.launcher.status(record.taskArn);
    if (status.state !== "STOPPED") return;
    const current = await this.repository.get(record.importId);
    if (!current) return;
    if (!isActiveImportState(current.state)) {
      await this.repository.clearActiveLock(current.importId);
      return;
    }
    await this.fail(current, now, {
      code: "WORKER_STOPPED",
      message: "O processamento foi interrompido antes de concluir.",
      retryable: true,
    });
  }

  private async recoverUpload(
    record: ImportRecord,
    now: Date,
  ): Promise<ImportRecord | null> {
    const uploadGeneration = record.uploadGeneration;
    const completionGeneration = record.completionUploadGeneration;
    if (
      importTimestampSchema.safeParse(record.completionRequestedAt).success &&
      Number.isSafeInteger(uploadGeneration) &&
      uploadGeneration !== undefined &&
      uploadGeneration > 0 &&
      Number.isSafeInteger(completionGeneration) &&
      completionGeneration !== undefined &&
      completionGeneration > 0 &&
      completionGeneration === uploadGeneration
    ) {
      const completed = await this.store.recoverCompleted(
        record.key,
        record.sizeBytes,
      );
      if (completed) {
        return this.repository.transition({
          importId: record.importId,
          expectedState: "UPLOADING",
          expectedVersion: record.version,
          nextState: "UPLOADED",
          patch: {
            physicalVersion: completed.versionId,
            updatedAt: now.toISOString(),
            progress: {
              kind: "bytes",
              completedBytes: record.sizeBytes,
              totalBytes: record.sizeBytes,
            },
          },
        });
      }
    }

    const expiresAt = Date.parse(record.uploadExpiresAt ?? "");
    if (!Number.isFinite(expiresAt) || now.getTime() < expiresAt) return null;
    if (record.uploadId)
      await this.store.abort(record.key, record.uploadId).catch(() => {});
    await this.fail(record, now, {
      code: "UPLOAD_EXPIRED",
      message: "O prazo de envio expirou.",
    });
    return null;
  }

  private async fail(
    record: ImportRecord,
    now: Date,
    error: { code: string; message: string; retryable?: boolean },
  ): Promise<void> {
    await this.repository.releaseTerminal(
      record.importId,
      record.version,
      "FAILED",
      {
        updatedAt: now.toISOString(),
        error: {
          ...error,
          requestId: importRequestId(record.importId),
        },
      },
    );
  }

  start(): void {
    if (this.stopped || this.timer) return;
    this.trigger();
    this.timer = this.setIntervalFn(() => this.trigger(), TICK_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      this.clearIntervalFn(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
  }

  private trigger(): void {
    if (this.stopped || this.inFlight) return;
    const run = this.reconcile(this.now()).catch((error: unknown) => {
      this.logger.error("import reconciliation failed", {
        event: "import_reconciliation_failed",
        error_name: reconciliationErrorCategory(error),
      });
    });
    this.inFlight = run.finally(() => {
      if (this.inFlight === wrapped) this.inFlight = undefined;
    });
    const wrapped = this.inFlight;
  }
}
