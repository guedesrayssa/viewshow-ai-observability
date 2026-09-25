import { describe, expect, it } from "vitest";
import { ServiceError } from "@view-show/contracts";
import type { Logger } from "@view-show/contracts";
import { ArgusLiveSyncUseCases } from "../src/modules/argus/application/argus-live-sync-use-cases.js";

const quietLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function createUseCases(
  control: ConstructorParameters<typeof ArgusLiveSyncUseCases>[0],
  scheduler: ConstructorParameters<typeof ArgusLiveSyncUseCases>[1],
): ArgusLiveSyncUseCases {
  return new ArgusLiveSyncUseCases(control, scheduler, quietLogger);
}

describe("ArgusLiveSyncUseCases", () => {
  it("blocks DynamoDB before disabling the scheduler", async () => {
    const calls: string[] = [];
    const useCases = createUseCases(
      {
        read: async () => false,
        write: async (value: boolean) => void calls.push(`write:${value}`),
      },
      {
        setEnabled: async (value: boolean) =>
          void calls.push(`schedule:${value}`),
      },
    );

    await expect(useCases.set(false)).resolves.toMatchObject({
      data: { enabled: false },
    });
    expect(calls).toEqual(["write:false", "schedule:false"]);
  });

  it("enables the scheduler before releasing the DynamoDB gate", async () => {
    const calls: string[] = [];
    const useCases = createUseCases(
      {
        read: async () => true,
        write: async (value: boolean) => void calls.push(`write:${value}`),
      },
      {
        setEnabled: async (value: boolean) =>
          void calls.push(`schedule:${value}`),
      },
    );

    await expect(useCases.set(true)).resolves.toMatchObject({
      data: { enabled: true },
    });
    expect(calls).toEqual(["schedule:true", "write:true"]);
  });

  it("maps infrastructure failures to a safe 503", async () => {
    const useCases = createUseCases(
      {
        read: async () => {
          throw new Error("secret table detail");
        },
        write: async () => undefined,
      },
      { setEnabled: async () => undefined },
    );

    await expect(useCases.get()).rejects.toMatchObject({
      status: 503,
      code: "FEATURE_UNAVAILABLE",
      message: "A configuração da sincronização com o ARGUS está indisponível.",
    });
  });

  it("maps scheduler failures to a safe 503", async () => {
    const useCases = createUseCases(
      { read: async () => false, write: async () => undefined },
      {
        setEnabled: async () => {
          throw new ServiceError(
            500,
            "DATA_UNAVAILABLE",
            "scheduler target detail",
          );
        },
      },
    );

    await expect(useCases.set(true)).rejects.toMatchObject({
      status: 503,
      code: "FEATURE_UNAVAILABLE",
      message: "A configuração da sincronização com o ARGUS está indisponível.",
    });
  });

  it("maps adapter ServiceErrors to the same safe 503", async () => {
    const useCases = createUseCases(
      {
        read: async () => {
          throw new ServiceError(
            500,
            "DATA_UNAVAILABLE",
            "infrastructure-bearing detail",
          );
        },
        write: async () => undefined,
      },
      { setEnabled: async () => undefined },
    );

    await expect(useCases.get()).rejects.toMatchObject({
      status: 503,
      code: "FEATURE_UNAVAILABLE",
      message: "A configuração da sincronização com o ARGUS está indisponível.",
    });
  });

  it("returns success when the enabling write commits before throwing", async () => {
    const calls: string[] = [];
    let persisted = false;
    let scheduled = false;
    const useCases = createUseCases(
      {
        read: async () => {
          calls.push("read");
          return persisted;
        },
        write: async (value: boolean) => {
          calls.push(`write:${value}`);
          persisted = value;
          if (value) throw new Error("timeout after commit");
        },
      },
      {
        setEnabled: async (value: boolean) => {
          calls.push(`schedule:${value}`);
          scheduled = value;
        },
      },
    );

    await expect(useCases.set(true)).resolves.toMatchObject({
      data: { enabled: true },
    });
    expect({ persisted, scheduled }).toEqual({
      persisted: true,
      scheduled: true,
    });
    expect(calls).toEqual(["schedule:true", "write:true", "read"]);
  });

  it("disables the scheduler when reconciliation confirms the gate stayed closed", async () => {
    const calls: string[] = [];
    let persisted = false;
    let scheduled = false;
    const useCases = createUseCases(
      {
        read: async () => {
          calls.push("read");
          return persisted;
        },
        write: async (value: boolean) => {
          calls.push(`write:${value}`);
          if (value) throw new Error("write rejected before commit");
          persisted = false;
        },
      },
      {
        setEnabled: async (value: boolean) => {
          calls.push(`schedule:${value}`);
          scheduled = value;
        },
      },
    );

    await expect(useCases.set(true)).rejects.toMatchObject({
      status: 503,
      code: "FEATURE_UNAVAILABLE",
    });
    expect({ persisted, scheduled }).toEqual({
      persisted: false,
      scheduled: false,
    });
    expect(calls).toEqual([
      "schedule:true",
      "write:true",
      "read",
      "schedule:false",
    ]);
  });

  it("closes the gate before disabling the scheduler when reconciliation is unavailable", async () => {
    const calls: string[] = [];
    let persisted = false;
    let scheduled = false;
    const useCases = createUseCases(
      {
        read: async () => {
          calls.push("read");
          throw new Error("read unavailable");
        },
        write: async (value: boolean) => {
          calls.push(`write:${value}`);
          if (value) throw new Error("ambiguous write");
          persisted = value;
        },
      },
      {
        setEnabled: async (value: boolean) => {
          calls.push(`schedule:${value}`);
          scheduled = value;
        },
      },
    );

    await expect(useCases.set(true)).rejects.toMatchObject({
      status: 503,
      code: "FEATURE_UNAVAILABLE",
    });
    expect({ persisted, scheduled }).toEqual({
      persisted: false,
      scheduled: false,
    });
    expect(calls).toEqual([
      "schedule:true",
      "write:true",
      "read",
      "write:false",
      "schedule:false",
    ]);
  });

  it("attempts scheduler compensation even when closing the gate also throws", async () => {
    const calls: string[] = [];
    let scheduled = false;
    const useCases = createUseCases(
      {
        read: async () => {
          calls.push("read");
          throw new Error("read unavailable");
        },
        write: async (value: boolean) => {
          calls.push(`write:${value}`);
          throw new Error(value ? "ambiguous write" : "close unavailable");
        },
      },
      {
        setEnabled: async (value: boolean) => {
          calls.push(`schedule:${value}`);
          scheduled = value;
        },
      },
    );

    await expect(useCases.set(true)).rejects.toMatchObject({ status: 503 });
    expect(scheduled).toBe(false);
    expect(calls).toEqual([
      "schedule:true",
      "write:true",
      "read",
      "write:false",
      "schedule:false",
    ]);
  });

  it("records only sanitized transition context for an infrastructure failure", async () => {
    const records: Array<{
      level: string;
      message: string;
      fields: Readonly<Record<string, unknown>> | undefined;
    }> = [];
    const logger: Logger = {
      info: (message, fields) =>
        records.push({ level: "info", message, fields }),
      warn: (message, fields) =>
        records.push({ level: "warn", message, fields }),
      error: (message, fields) =>
        records.push({ level: "error", message, fields }),
    };
    const useCases = Reflect.construct(ArgusLiveSyncUseCases, [
      {
        read: async () => false,
        write: async () => {
          throw new Error("secret infrastructure detail");
        },
      },
      { setEnabled: async () => undefined },
      logger,
    ]) as ArgusLiveSyncUseCases;

    await expect(useCases.set(true)).rejects.toMatchObject({ status: 503 });
    expect(records).toContainEqual({
      level: "error",
      message: "ARGUS live sync transition failed",
      fields: {
        desired_enabled: true,
        transition_step: "enable_gate_write",
        error_name: "Error",
      },
    });
    expect(JSON.stringify(records)).not.toContain(
      "secret infrastructure detail",
    );
  });
});
