import { describe, expect, it } from "vitest";
import { ServiceError, type Logger } from "@view-show/contracts";
import { requireActiveDataset } from "../src/modules/datasets/application/require-active-dataset.ts";
import { ActiveDatasetContractError } from "../src/modules/datasets/domain/active-dataset.ts";
import type { ActiveDatasetResolver } from "../src/modules/datasets/ports/active-dataset-resolver.ts";

type Record_ = {
  readonly level: string;
  readonly message: string;
  readonly fields: unknown;
};

function recordingLogger(): {
  readonly logger: Logger;
  readonly records: Record_[];
} {
  const records: Record_[] = [];
  const capture = (level: string) => (message: string, fields?: unknown) => {
    records.push({ level, message, fields });
  };
  return {
    logger: {
      info: capture("info"),
      warn: capture("warn"),
      error: capture("error"),
    } as Logger,
    records,
  };
}

const publicMessage =
  "Nenhuma versão ativa e compatível do dataset está disponível.";

async function refusal(
  resolver: ActiveDatasetResolver,
  logger: Logger,
): Promise<ServiceError> {
  try {
    await requireActiveDataset(resolver, logger);
  } catch (error) {
    return error as ServiceError;
  }
  throw new Error("requireActiveDataset resolved when it should have refused");
}

describe("requireActiveDataset observability", () => {
  it("records that the pointer is absent while keeping the public refusal identical", async () => {
    const { logger, records } = recordingLogger();
    const error = await refusal(
      {
        async resolve() {
          return null;
        },
      },
      logger,
    );

    expect(error.status).toBe(503);
    expect(error.code).toBe("DATA_UNAVAILABLE");
    expect(error.message).toBe(publicMessage);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ fields: { reason: "absent" } });
  });

  it("distinguishes a manifest outside the consumed contract from an absent pointer", async () => {
    const { logger, records } = recordingLogger();
    const error = await refusal(
      {
        async resolve() {
          throw new ActiveDatasetContractError();
        },
      },
      logger,
    );

    expect(error.message).toBe(publicMessage);
    expect(records).toHaveLength(1);
    expect(records[0]?.level).toBe("error");
    expect(records[0]).toMatchObject({ fields: { reason: "contract" } });
  });

  it("distinguishes an unreadable store from an absent pointer", async () => {
    const { logger, records } = recordingLogger();
    const error = await refusal(
      {
        async resolve() {
          throw new Error("ProvisionedThroughputExceededException");
        },
      },
      logger,
    );

    expect(error.message).toBe(publicMessage);
    expect(records).toHaveLength(1);
    expect(records[0]?.level).toBe("error");
    expect(records[0]).toMatchObject({ fields: { reason: "io" } });
  });

  it("never puts the store failure text in the public refusal", async () => {
    const { logger } = recordingLogger();
    const error = await refusal(
      {
        async resolve() {
          throw new Error("table view-show-operacional key CONTROL#DATASET");
        },
      },
      logger,
    );

    expect(error.message).not.toContain("view-show-operacional");
    expect(error.message).not.toContain("CONTROL#DATASET");
  });
});
