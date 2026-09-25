import {
  ServiceError,
  createLogger,
  type InternalResponse,
  type Logger,
} from "@view-show/contracts";
import type { ArgusLiveSyncControlPort } from "../ports/argus-live-sync-control.js";
import type { ArgusSchedulerPort } from "../ports/argus-scheduler.js";

function unavailable(): ServiceError {
  return new ServiceError(
    503,
    "FEATURE_UNAVAILABLE",
    "A configuração da sincronização com o ARGUS está indisponível.",
  );
}

function response(enabled: boolean): InternalResponse<{ enabled: boolean }> {
  return {
    data: { enabled },
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

const defaultLogger = createLogger("api");

type TransitionStep =
  | "read_gate"
  | "enable_scheduler"
  | "enable_gate_write"
  | "enable_gate_reconcile"
  | "compensate_gate_close"
  | "compensate_scheduler_disable"
  | "disable_gate_write"
  | "disable_scheduler";

export class ArgusLiveSyncUseCases {
  constructor(
    private readonly control: ArgusLiveSyncControlPort,
    private readonly scheduler: ArgusSchedulerPort,
    private readonly logger: Logger = defaultLogger,
  ) {}

  private logFailure(
    step: TransitionStep,
    desiredEnabled: boolean,
    error: unknown,
  ): void {
    this.logger.error("ARGUS live sync transition failed", {
      desired_enabled: desiredEnabled,
      transition_step: step,
      error_name: error instanceof Error ? error.name : "unknown",
    });
  }

  private async failClosedAfterUnknownReconciliation(): Promise<void> {
    try {
      await this.control.write(false);
    } catch (error) {
      this.logFailure("compensate_gate_close", false, error);
    }
    try {
      await this.scheduler.setEnabled(false);
    } catch (error) {
      this.logFailure("compensate_scheduler_disable", false, error);
    }
  }

  async get(): Promise<InternalResponse<{ enabled: boolean }>> {
    try {
      return response(await this.control.read());
    } catch (error) {
      this.logFailure("read_gate", false, error);
      throw unavailable();
    }
  }

  async set(enabled: boolean): Promise<InternalResponse<{ enabled: boolean }>> {
    if (!enabled) {
      try {
        await this.control.write(false);
      } catch (error) {
        this.logFailure("disable_gate_write", false, error);
        throw unavailable();
      }
      try {
        await this.scheduler.setEnabled(false);
      } catch (error) {
        this.logFailure("disable_scheduler", false, error);
        throw unavailable();
      }
      return response(false);
    }

    try {
      await this.scheduler.setEnabled(true);
    } catch (error) {
      this.logFailure("enable_scheduler", true, error);
      throw unavailable();
    }

    try {
      await this.control.write(true);
      return response(true);
    } catch (error) {
      this.logFailure("enable_gate_write", true, error);
    }

    let reconciled: boolean;
    try {
      reconciled = await this.control.read();
    } catch (error) {
      this.logFailure("enable_gate_reconcile", true, error);
      await this.failClosedAfterUnknownReconciliation();
      throw unavailable();
    }

    if (reconciled) {
      this.logger.warn("ARGUS live sync write reconciled", {
        desired_enabled: true,
        transition_step: "enable_gate_reconcile",
        reconciliation: "confirmed_enabled",
      });
      return response(true);
    }

    try {
      await this.scheduler.setEnabled(false);
    } catch (error) {
      this.logFailure("compensate_scheduler_disable", false, error);
    }
    throw unavailable();
  }
}
