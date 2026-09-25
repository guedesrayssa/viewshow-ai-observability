import { act, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ImportUploadProvider,
  useImportUpload,
  type ImportUploadContextValue,
} from "@/components/imports/import-upload-provider";
import { ApiError } from "@/lib/data/client";
import type { ImportSnapshot } from "@/lib/imports/types";

const MiB = 1024 * 1024;
const capture = vi.fn();

function currentContext(): ImportUploadContextValue {
  const call = capture.mock.calls.at(-1);
  if (!call) throw new Error("O contexto ainda não foi publicado no teste.");
  return call[0] as ImportUploadContextValue;
}

function snapshot(overrides: Partial<ImportSnapshot> = {}): ImportSnapshot {
  return {
    importId: "imp_01K5BB9WQ6EJ5V6TVCMSK74NQ3",
    requestedBy: "usr_owner",
    author: { id: "usr_owner", name: "Maria", email: null },
    canManageUpload: true,
    fileName: "argus_dump.sql.gz",
    sizeBytes: 40 * MiB,
    snapshotExtractedOn: "2026-09-17",
    createdAt: "2026-09-17T10:00:00.000Z",
    updatedAt: "2026-09-17T10:00:00.000Z",
    state: "UPLOADING",
    version: 2,
    progress: { kind: "bytes", completedBytes: 0, totalBytes: 40 * MiB },
    candidateVersion: null,
    error: null,
    ...overrides,
  };
}

function clientFixture(items: ImportSnapshot[] = []) {
  return {
    list: vi.fn(async () => ({
      items,
      cursor: null,
      activeDatasetVersion: null,
    })),
    get: vi.fn(
      async (id: string) =>
        items.find((item) => item.importId === id) ?? snapshot(),
    ),
    start: vi.fn(async () => snapshot()),
    listParts: vi.fn(async () => []),
    signParts: vi.fn(async () => []),
    restart: vi.fn(async () => snapshot()),
    complete: vi.fn(async () => snapshot({ state: "UPLOADED", version: 3 })),
    activate: vi.fn(async (importId: string) => ({
      importId,
      datasetVersion: `dsv_${"a".repeat(64)}`,
      activatedAt: "2026-09-17T10:04:00.000Z",
      activatedBy: "usr_reader",
      changed: true,
    })),
  };
}

function Probe({ label = "one" }: { label?: string }) {
  const context = useImportUpload();
  useEffect(() => capture(context), [context]);
  return (
    <div>
      <span data-testid="label">{label}</span>
      <span data-testid="loading">{String(context.loading)}</span>
      <span data-testid="needs-file">
        {String(context.needsFileReselection)}
      </span>
      <span data-testid="transfer">{context.transfer}</span>
      <span data-testid="active-state">
        {context.activeImport?.state ?? "none"}
      </span>
      <span data-testid="confirmed">
        {context.activeImport?.progress.kind === "bytes"
          ? context.activeImport.progress.completedBytes
          : "none"}
      </span>
      <span data-testid="stage">
        {context.activeImport?.progress.kind === "stage"
          ? JSON.stringify(context.activeImport.progress)
          : "none"}
      </span>
      <span data-testid="ids">
        {context.imports.map((item) => item.importId).join(",")}
      </span>
      <span data-testid="read-error-code">
        {context.readError?.code ?? "none"}
      </span>
      <span data-testid="transfer-error-code">
        {context.transferError?.code ?? "none"}
      </span>
      <span data-testid="conflict-error-code">
        {context.conflict?.error.code ?? "none"}
      </span>
      <span data-testid="cursor">{context.nextCursor ?? "none"}</span>
      <span data-testid="active-dataset">
        {(context as unknown as { activeDatasetVersion: string | null })
          .activeDatasetVersion ?? "none"}
      </span>
      <span data-testid="history-states">
        {context.imports
          .map((item) => `${item.importId}:${item.state}`)
          .join(",")}
      </span>
      <span data-testid="upload-confirmed">
        {context.uploadProgress?.confirmedBytes ?? "none"}
      </span>
      <span data-testid="upload-in-flight">
        {context.uploadProgress?.inFlightBytes ?? "none"}
      </span>
      <span data-testid="upload-visible">
        {context.uploadProgress
          ? context.uploadProgress.confirmedBytes +
            context.uploadProgress.inFlightBytes
          : "none"}
      </span>
    </div>
  );
}

afterEach(() => {
  capture.mockReset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ImportUploadProvider", () => {
  it("activates a READY candidate and publishes the new active dataset", async () => {
    const candidateVersion = `dsv_${"a".repeat(64)}`;
    const candidate = snapshot({
      state: "READY",
      progress: { kind: "none" },
      candidateVersion,
    });
    const client = clientFixture([candidate]);
    render(
      <ImportUploadProvider
        client={client}
        createIdempotencyKey={() => "activate-key"}
      >
        <Probe />
      </ImportUploadProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("false"),
    );

    await act(async () => {
      await (
        currentContext() as unknown as {
          activate(importId: string): Promise<void>;
        }
      ).activate(candidate.importId);
    });

    expect(client.activate).toHaveBeenCalledWith(candidate.importId, {
      idempotencyKey: "activate-key",
    });
    expect(screen.getByTestId("active-dataset")).toHaveTextContent(
      candidateVersion,
    );
  });

  it("no reload exige nova seleção somente do owner em UPLOADING", async () => {
    const owner = snapshot();
    const ownerClient = clientFixture([owner]);
    const view = render(
      <ImportUploadProvider client={ownerClient}>
        <Probe />
      </ImportUploadProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("false"),
    );
    expect(screen.getByTestId("needs-file")).toHaveTextContent("true");
    expect(ownerClient.listParts).not.toHaveBeenCalled();
    view.unmount();

    const reader = snapshot({ canManageUpload: false });
    const readerClient = clientFixture([reader]);
    render(
      <ImportUploadProvider client={readerClient}>
        <Probe />
      </ImportUploadProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("false"),
    );
    expect(screen.getByTestId("needs-file")).toHaveTextContent("false");
    expect(readerClient.listParts).not.toHaveBeenCalled();
  });

  it("start resolve após reservar, sobrevive troca de children e aborta só no unmount", async () => {
    const client = clientFixture();
    let resolveUpload!: (value: ImportSnapshot) => void;
    let uploadSignal: AbortSignal | null = null;
    const uploadFile = vi.fn(
      (input: { signal: AbortSignal }) =>
        new Promise<ImportSnapshot>((resolve) => {
          uploadSignal = input.signal;
          resolveUpload = resolve;
        }),
    );
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const file = new File([new Uint8Array(40 * MiB)], "argus_dump.sql.gz");
    const view = render(
      <ImportUploadProvider client={client} uploadFile={uploadFile}>
        <Probe label="one" />
      </ImportUploadProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("false"),
    );

    await act(async () => {
      await currentContext().startUpload(file, "2026-09-17");
    });

    expect(client.start).toHaveBeenCalledTimes(1);
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("transfer")).toHaveTextContent("uploading");
    expect(uploadSignal?.aborted).toBe(false);

    view.rerender(
      <ImportUploadProvider client={client} uploadFile={uploadFile}>
        <Probe label="two" />
      </ImportUploadProvider>,
    );
    expect(screen.getByTestId("label")).toHaveTextContent("two");
    expect(uploadSignal?.aborted).toBe(false);

    view.unmount();
    expect(uploadSignal?.aborted).toBe(true);
    expect(storage).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
    resolveUpload(snapshot({ state: "UPLOADED", version: 3 }));
  });

  it("reutiliza a chave enquanto start é incerto e cria outra após reserva confirmada", async () => {
    const client = clientFixture();
    const keys = vi.fn(
      (action: "start" | "restart" | "complete") =>
        `${action}-key-${keys.mock.calls.length}`,
    );
    client.start
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(
        snapshot({
          importId: "imp_01K5BB9WQ6EJ5V6TVCMSK74NQ4",
          version: 1,
        }),
      );
    const uploadFile = vi.fn(() => new Promise<ImportSnapshot>(() => {}));
    const file = new File([new Uint8Array(40 * MiB)], "argus_dump.sql.gz");
    render(
      <ImportUploadProvider
        client={client}
        uploadFile={uploadFile}
        createIdempotencyKey={keys}
      >
        <Probe />
      </ImportUploadProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("false"),
    );

    let firstFailure: unknown;
    await act(async () => {
      try {
        await currentContext().startUpload(file, "2026-09-17");
      } catch (caught) {
        firstFailure = caught;
      }
    });
    expect(firstFailure).toMatchObject({ message: "Failed to fetch" });
    await act(async () => currentContext().startUpload(file, "2026-09-17"));
    await act(async () => currentContext().startUpload(file, "2026-09-17"));

    const usedKeys = client.start.mock.calls.map(
      (call) => call[1].idempotencyKey,
    );
    expect(usedKeys[0]).toBe(usedKeys[1]);
    expect(usedKeys[2]).not.toBe(usedKeys[1]);
  });

  it("coordena restart incerto e confirmado entre tentativas do runner", async () => {
    const client = clientFixture();
    const keys = vi.fn(
      (action: "start" | "restart" | "complete") =>
        `${action}-key-${keys.mock.calls.length}`,
    );
    const restartKeys: string[] = [];
    let run = 0;
    const uploadFile = vi.fn(
      (input: {
        createIdempotencyKey?: (action: "restart" | "complete") => string;
        confirmIdempotencyKey?: (
          action: "restart" | "complete",
          key: string,
        ) => void;
      }) => {
        run += 1;
        const key = input.createIdempotencyKey?.("restart");
        if (!key) throw new Error("coordenador ausente");
        restartKeys.push(key);
        if (run === 2) input.confirmIdempotencyKey?.("restart", key);
        return Promise.reject(
          new Error(run === 1 ? "restart incerto" : "falha depois do restart"),
        );
      },
    );
    const file = new File([new Uint8Array(40 * MiB)], "argus_dump.sql.gz");
    render(
      <ImportUploadProvider
        client={client}
        uploadFile={uploadFile}
        createIdempotencyKey={keys}
      >
        <Probe />
      </ImportUploadProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("false"),
    );
    await act(async () => currentContext().startUpload(file, "2026-09-17"));
    await waitFor(() =>
      expect(screen.getByTestId("transfer")).toHaveTextContent("failed"),
    );
    await act(async () => currentContext().retryUpload());
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId("transfer")).toHaveTextContent("failed"),
    );
    await act(async () => currentContext().retryUpload());
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(3));

    expect(restartKeys[0]).toBe(restartKeys[1]);
    expect(restartKeys[2]).not.toBe(restartKeys[1]);
  });

  it("resume valida o arquivo e delega a retomada ao motor sem expor seleção", async () => {
    const active = snapshot();
    const client = clientFixture([active]);
    const uploadFile = vi.fn(async () =>
      snapshot({ state: "UPLOADED", version: 3 }),
    );
    render(
      <ImportUploadProvider client={client} uploadFile={uploadFile}>
        <Probe />
      </ImportUploadProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("needs-file")).toHaveTextContent("true"),
    );

    await expect(
      currentContext().resumeUpload(new File(["bad"], "other.zip")),
    ).rejects.toThrow(/arquivo/i);
    expect(uploadFile).not.toHaveBeenCalled();

    const valid = new File([new Uint8Array(40 * MiB)], "argus_dump.sql.gz");
    await act(async () => {
      await currentContext().resumeUpload(valid);
    });
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("needs-file")).toHaveTextContent("false");
    await waitFor(() =>
      expect(screen.getByTestId("active-state")).toHaveTextContent("UPLOADED"),
    );
    await expect(currentContext().retryUpload()).rejects.toThrow(/selecione/i);
  });

  it("polling não sobrepõe, pausa hidden, atualiza visible e limpa timer", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    const active = snapshot();
    const client = clientFixture([active]);
    let releasePoll!: (value: ImportSnapshot) => void;
    client.get
      .mockResolvedValueOnce(active)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releasePoll = resolve;
          }),
      )
      .mockResolvedValueOnce(snapshot({ state: "READY", version: 3 }));
    const view = render(
      <ImportUploadProvider client={client} pollIntervalMs={5_000}>
        <Probe />
      </ImportUploadProvider>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(client.get).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(client.get).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(client.get).toHaveBeenCalledTimes(2);

    visibility = "hidden";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    releasePoll(
      snapshot({
        progress: {
          kind: "bytes",
          completedBytes: 16 * MiB,
          totalBytes: 40 * MiB,
        },
      }),
    );
    await act(async () => await Promise.resolve());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(client.get).toHaveBeenCalledTimes(2);

    visibility = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(client.get).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId("active-state")).toHaveTextContent("none");
    expect(vi.getTimerCount()).toBe(0);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("não executa refresh enfileirado por visibility após resposta terminal", async () => {
    vi.useFakeTimers();
    const active = snapshot();
    const client = clientFixture([active]);
    let resolvePoll!: (value: ImportSnapshot) => void;
    client.get
      .mockResolvedValueOnce(active)
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolvePoll = resolve)),
      );
    const view = render(
      <ImportUploadProvider client={client} pollIntervalMs={5_000}>
        <Probe />
      </ImportUploadProvider>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(client.get).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(client.get).toHaveBeenCalledTimes(2);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => {
      resolvePoll(
        snapshot({ state: "READY", version: 3, progress: { kind: "none" } }),
      );
      await Promise.resolve();
    });

    expect(client.get).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("active-state")).toHaveTextContent("none");
    view.unmount();
  });

  it("não inicia polling enquanto o status inicial da importação ainda está pendente", async () => {
    vi.useFakeTimers();
    const active = snapshot();
    const client = clientFixture([active]);
    let releaseInitial!: (value: ImportSnapshot) => void;
    client.get.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseInitial = resolve;
        }),
    );
    const view = render(
      <ImportUploadProvider client={client} pollIntervalMs={5_000}>
        <Probe />
      </ImportUploadProvider>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(client.get).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(client.get).toHaveBeenCalledTimes(1);

    releaseInitial(active);
    await act(async () => await Promise.resolve());
    view.unmount();
  });

  it("aborta a transferência local quando o backend publica estado terminal", async () => {
    vi.useFakeTimers();
    const client = clientFixture();
    client.get.mockResolvedValue(snapshot({ state: "FAILED", version: 3 }));
    let uploadSignal: AbortSignal | null = null;
    const uploadFile = vi.fn(
      (input: { signal: AbortSignal }) =>
        new Promise<ImportSnapshot>(() => {
          uploadSignal = input.signal;
        }),
    );
    const file = new File([new Uint8Array(40 * MiB)], "argus_dump.sql.gz");
    const view = render(
      <ImportUploadProvider
        client={client}
        uploadFile={uploadFile}
        pollIntervalMs={5_000}
      >
        <Probe />
      </ImportUploadProvider>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await currentContext().startUpload(file, "2026-09-17");
    });
    expect(uploadSignal?.aborted).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(uploadSignal?.aborted).toBe(true);
    expect(screen.getByTestId("active-state")).toHaveTextContent("none");
    view.unmount();
  });

  it("mescla bytes da mesma versão sem regredir e preserva stage sem percentual", async () => {
    const active = snapshot();
    const client = clientFixture([active]);
    client.get
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce(
        snapshot({
          progress: {
            kind: "bytes",
            completedBytes: 16 * MiB,
            totalBytes: 40 * MiB,
          },
        }),
      )
      .mockResolvedValueOnce(
        snapshot({ state: "FAILED", version: 1, progress: { kind: "none" } }),
      )
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce(
        snapshot({
          state: "PROCESSING",
          version: 3,
          progress: {
            kind: "stage",
            stage: "INGESTING",
            recordsRead: 10,
            recordsWritten: 7,
            recordsRejected: 1,
          },
        }),
      );
    render(
      <ImportUploadProvider client={client}>
        <Probe />
      </ImportUploadProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("false"),
    );

    await act(async () => {
      await currentContext().refresh();
    });
    expect(screen.getByTestId("confirmed")).toHaveTextContent(String(16 * MiB));
    await act(async () => {
      await currentContext().refresh();
    });
    expect(screen.getByTestId("active-state")).toHaveTextContent("UPLOADING");
    expect(screen.getByTestId("confirmed")).toHaveTextContent(String(16 * MiB));
    await act(async () => {
      await currentContext().refresh();
    });
    expect(screen.getByTestId("confirmed")).toHaveTextContent(String(16 * MiB));
    await act(async () => {
      await currentContext().refresh();
    });
    expect(screen.getByTestId("stage")).toHaveTextContent("INGESTING");
    expect(screen.getByTestId("stage").textContent).not.toContain("percent");
  });

  it("pagina pelo cursor, acrescenta novos IDs e não duplica os existentes", async () => {
    const first = snapshot({ state: "READY", version: 3 });
    const second = snapshot({
      importId: "imp_01K5BB9WQ6EJ5V6TVCMSK74NQ4",
      state: "READY",
      version: 1,
    });
    const client = clientFixture();
    client.list
      .mockResolvedValueOnce({ items: [first], cursor: "next/page" })
      .mockResolvedValueOnce({ items: [first, second], cursor: null });
    render(
      <ImportUploadProvider client={client}>
        <Probe />
      </ImportUploadProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("false"),
    );

    await act(async () => currentContext().loadMore());

    expect(client.list).toHaveBeenLastCalledWith(
      { limit: 50, cursor: "next/page" },
      { signal: expect.any(AbortSignal) },
    );
    expect(screen.getByTestId("ids").textContent?.split(",")).toEqual([
      first.importId,
      second.importId,
    ]);
  });

  it("representa e sinaliza a reserva existente quando start recebe 409", async () => {
    const existing = snapshot({ canManageUpload: false });
    const client = clientFixture();
    client.start.mockRejectedValue(
      new ApiError(
        "Já existe uma importação em andamento.",
        409,
        "IMPORT_IN_PROGRESS",
        "req_conflict",
        undefined,
        { importId: existing.importId },
      ),
    );
    client.get.mockResolvedValue(existing);
    const uploadFile = vi.fn();
    render(
      <ImportUploadProvider client={client} uploadFile={uploadFile}>
        <Probe />
      </ImportUploadProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("false"),
    );

    await act(async () => {
      await currentContext().startUpload(
        new File(["x"], "argus_dump.sql.gz"),
        "2026-09-17",
      );
    });

    expect(screen.getByTestId("active-state")).toHaveTextContent("UPLOADING");
    expect(screen.getByTestId("conflict-error-code")).toHaveTextContent(
      "IMPORT_IN_PROGRESS",
    );
    expect(screen.getByTestId("read-error-code")).toHaveTextContent("none");
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("não ressuscita terminal quando refresh antigo resolve depois", async () => {
    const active = snapshot();
    const terminal = snapshot({
      state: "READY",
      version: 3,
      progress: { kind: "none" },
    });
    const client = clientFixture([active]);
    client.get.mockResolvedValueOnce(active);
    render(
      <ImportUploadProvider client={client}>
        <Probe />
      </ImportUploadProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("false"),
    );

    let resolveOld!: (value: ImportSnapshot) => void;
    let resolveNew!: (value: ImportSnapshot) => void;
    client.get
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveOld = resolve)),
      )
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveNew = resolve)),
      );
    let oldRefresh!: Promise<void>;
    let newRefresh!: Promise<void>;
    act(() => {
      oldRefresh = currentContext().refresh();
      newRefresh = currentContext().refresh();
    });
    await act(async () => {
      resolveNew(terminal);
      await newRefresh;
    });
    await act(async () => {
      resolveOld(active);
      await oldRefresh;
    });

    expect(screen.getByTestId("active-state")).toHaveTextContent("none");
    expect(screen.getByTestId("history-states")).toHaveTextContent(
      `${active.importId}:READY`,
    );
  });

  it("resposta stale do import antigo não substitui nem aborta o upload novo", async () => {
    const importA = snapshot();
    const importB = snapshot({
      importId: "imp_01K5BB9WQ6EJ5V6TVCMSK74NQ4",
      version: 1,
    });
    const client = clientFixture([importA]);
    client.get.mockResolvedValueOnce(importA);
    let uploadSignal: AbortSignal | null = null;
    render(
      <ImportUploadProvider
        client={client}
        uploadFile={vi.fn((input: { signal: AbortSignal }) => {
          uploadSignal = input.signal;
          return new Promise<ImportSnapshot>(() => {});
        })}
      >
        <Probe />
      </ImportUploadProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("false"),
    );

    let resolveOld!: (value: ImportSnapshot) => void;
    client.get
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveOld = resolve)),
      )
      .mockResolvedValueOnce(
        snapshot({ state: "READY", version: 3, progress: { kind: "none" } }),
      );
    let staleRefresh!: Promise<void>;
    act(() => {
      staleRefresh = currentContext().refresh();
    });
    await act(async () => currentContext().refresh());
    client.start.mockResolvedValue(importB);
    await act(async () => {
      await currentContext().startUpload(
        new File([new Uint8Array(40 * MiB)], "argus_dump.sql.gz"),
        "2026-09-17",
      );
    });
    await act(async () => {
      resolveOld(importA);
      await staleRefresh;
    });

    expect(currentContext().activeImport?.importId).toBe(importB.importId);
    expect(uploadSignal?.aborted).toBe(false);
  });

  it("list e GET iniciados antes da reserva não promovem A sobre o runner B", async () => {
    const importA = snapshot();
    const importB = snapshot({
      importId: "imp_01K5BB9WQ6EJ5V6TVCMSK74NQ4",
      createdAt: "2026-09-17T10:01:00.000Z",
      updatedAt: "2026-09-17T10:01:00.000Z",
      version: 1,
    });
    const client = clientFixture();
    let resolveOldList!: (page: {
      items: ImportSnapshot[];
      cursor: string | null;
    }) => void;
    let resolveOldGet!: (record: ImportSnapshot) => void;
    client.list
      .mockResolvedValueOnce({ items: [], cursor: null })
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveOldList = resolve)),
      );
    client.get.mockImplementation(
      () => new Promise((resolve) => (resolveOldGet = resolve)),
    );
    client.start.mockResolvedValue(importB);
    let uploadSignal: AbortSignal | null = null;
    const uploadFile = vi.fn(
      (input: { signal: AbortSignal }) =>
        new Promise<ImportSnapshot>(() => {
          uploadSignal = input.signal;
        }),
    );
    render(
      <ImportUploadProvider client={client} uploadFile={uploadFile}>
        <Probe />
      </ImportUploadProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("false"),
    );

    let oldRefresh!: Promise<void>;
    act(() => {
      oldRefresh = currentContext().refresh();
    });
    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
    await act(async () => {
      await currentContext().startUpload(
        new File([new Uint8Array(40 * MiB)], "argus_dump.sql.gz"),
        "2026-09-17",
      );
    });
    await act(async () => {
      resolveOldList({ items: [importA], cursor: "old-page" });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(client.get).toHaveBeenCalledWith(importA.importId, {
        signal: expect.any(AbortSignal),
      }),
    );
    expect(screen.getByTestId("ids").textContent?.split(",")).toEqual([
      importB.importId,
      importA.importId,
    ]);
    await act(async () => {
      resolveOldGet(importA);
      await oldRefresh;
    });

    expect(currentContext().activeImport?.importId).toBe(importB.importId);
    expect(uploadSignal?.aborted).toBe(false);
    expect(screen.getByTestId("ids").textContent?.split(",")).toEqual([
      importB.importId,
      importA.importId,
    ]);
  });

  it.each(["A antes de B", "B antes de A"])(
    "ordena GETs invertidos sem deixar refresh antigo substituir B: %s",
    async (resolutionOrder) => {
      const importA = snapshot();
      const importB = snapshot({
        importId: "imp_01K5BB9WQ6EJ5V6TVCMSK74NQ4",
        createdAt: "2026-09-17T10:01:00.000Z",
        updatedAt: "2026-09-17T10:01:00.000Z",
        version: 1,
      });
      const client = clientFixture();
      client.list
        .mockResolvedValueOnce({ items: [], cursor: null })
        .mockResolvedValueOnce({ items: [importA], cursor: null });
      let resolveA!: (record: ImportSnapshot) => void;
      let resolveB!: (record: ImportSnapshot) => void;
      client.get.mockImplementation(
        (importId: string) =>
          new Promise((resolve) => {
            if (importId === importA.importId) resolveA = resolve;
            else resolveB = resolve;
          }),
      );
      client.start.mockResolvedValue(importB);
      let uploadSignal: AbortSignal | null = null;
      render(
        <ImportUploadProvider
          client={client}
          uploadFile={vi.fn((input: { signal: AbortSignal }) => {
            uploadSignal = input.signal;
            return new Promise<ImportSnapshot>(() => {});
          })}
        >
          <Probe />
        </ImportUploadProvider>,
      );
      await waitFor(() =>
        expect(screen.getByTestId("loading")).toHaveTextContent("false"),
      );

      let oldRefresh!: Promise<void>;
      act(() => {
        oldRefresh = currentContext().refresh();
      });
      await waitFor(() => expect(resolveA).toBeTypeOf("function"));
      await act(async () => {
        await currentContext().startUpload(
          new File([new Uint8Array(40 * MiB)], "argus_dump.sql.gz"),
          "2026-09-17",
        );
      });
      let freshRefresh!: Promise<void>;
      act(() => {
        freshRefresh = currentContext().refresh();
      });
      await waitFor(() => expect(resolveB).toBeTypeOf("function"));

      if (resolutionOrder === "A antes de B") {
        await act(async () => {
          resolveA(importA);
          await oldRefresh;
        });
        await act(async () => {
          resolveB(importB);
          await freshRefresh;
        });
      } else {
        await act(async () => {
          resolveB(importB);
          await freshRefresh;
        });
        await act(async () => {
          resolveA(importA);
          await oldRefresh;
        });
      }

      expect(currentContext().activeImport?.importId).toBe(importB.importId);
      expect(uploadSignal?.aborted).toBe(false);
    },
  );

  it("não conta novamente bytes em voo quando o backend confirma a mesma parte", async () => {
    const client = clientFixture();
    let reportProgress!: (progress: {
      confirmedBytes: number;
      inFlightBytes: number;
      totalBytes: number;
    }) => void;
    const uploadFile = vi.fn(
      (input: { onProgress: typeof reportProgress }) =>
        new Promise<ImportSnapshot>(() => {
          reportProgress = input.onProgress;
        }),
    );
    render(
      <ImportUploadProvider client={client} uploadFile={uploadFile}>
        <Probe />
      </ImportUploadProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("false"),
    );
    await act(async () => {
      await currentContext().startUpload(
        new File([new Uint8Array(40 * MiB)], "argus_dump.sql.gz"),
        "2026-09-17",
      );
    });
    act(() => {
      reportProgress({
        confirmedBytes: 0,
        inFlightBytes: 16 * MiB,
        totalBytes: 40 * MiB,
      });
    });
    client.get.mockResolvedValueOnce(
      snapshot({
        progress: {
          kind: "bytes",
          completedBytes: 16 * MiB,
          totalBytes: 40 * MiB,
        },
      }),
    );
    await act(async () => currentContext().refresh());

    expect(screen.getByTestId("upload-confirmed")).toHaveTextContent(
      String(16 * MiB),
    );
    expect(screen.getByTestId("upload-in-flight")).toHaveTextContent("0");
    expect(screen.getByTestId("upload-visible")).toHaveTextContent(
      String(16 * MiB),
    );

    act(() => {
      reportProgress({
        confirmedBytes: 16 * MiB,
        inFlightBytes: 24 * MiB,
        totalBytes: 40 * MiB,
      });
    });
    client.get.mockResolvedValueOnce(
      snapshot({
        progress: {
          kind: "bytes",
          completedBytes: 32 * MiB,
          totalBytes: 40 * MiB,
        },
      }),
    );
    await act(async () => currentContext().refresh());
    expect(screen.getByTestId("upload-visible")).toHaveTextContent(
      String(40 * MiB),
    );
    expect(screen.getByTestId("upload-in-flight")).toHaveTextContent(
      String(8 * MiB),
    );
  });

  it("409 seguido de falha no GET sai de starting e refresh recupera", async () => {
    const existing = snapshot({ canManageUpload: false });
    const conflict = new ApiError(
      "Já existe uma importação em andamento.",
      409,
      "IMPORT_IN_PROGRESS",
      "req_conflict",
      undefined,
      { importId: existing.importId },
    );
    const client = clientFixture();
    client.list
      .mockResolvedValueOnce({ items: [], cursor: null })
      .mockResolvedValueOnce({ items: [existing], cursor: null });
    client.start.mockRejectedValue(conflict);
    client.get
      .mockRejectedValueOnce(
        new ApiError("Indisponível", 503, "DATA_UNAVAILABLE", "req_get"),
      )
      .mockResolvedValueOnce(existing);
    render(
      <ImportUploadProvider client={client}>
        <Probe />
      </ImportUploadProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("false"),
    );

    let resolutionFailure: unknown;
    await act(async () => {
      try {
        await currentContext().startUpload(
          new File(["x"], "argus_dump.sql.gz"),
          "2026-09-17",
        );
      } catch (caught) {
        resolutionFailure = caught;
      }
    });
    expect(resolutionFailure).toMatchObject({ code: "DATA_UNAVAILABLE" });
    expect(screen.getByTestId("transfer")).toHaveTextContent("idle");
    expect(screen.getByTestId("conflict-error-code")).toHaveTextContent(
      "IMPORT_IN_PROGRESS",
    );
    expect(screen.getByTestId("read-error-code")).toHaveTextContent(
      "DATA_UNAVAILABLE",
    );
    expect(currentContext().conflict?.importId).toBe(existing.importId);
    expect(currentContext().conflict?.error.details?.importId).toBe(
      existing.importId,
    );
    expect(screen.getByTestId("active-state")).toHaveTextContent("none");

    await act(async () => currentContext().refresh());
    expect(screen.getByTestId("active-state")).toHaveTextContent("UPLOADING");
    expect(screen.getByTestId("read-error-code")).toHaveTextContent("none");
    expect(screen.getByTestId("conflict-error-code")).toHaveTextContent(
      "IMPORT_IN_PROGRESS",
    );
  });

  it("aborta a resolução auxiliar do 409 no unmount sem nova publicação", async () => {
    const existing = snapshot();
    const client = clientFixture();
    client.start.mockRejectedValue(
      new ApiError(
        "Já existe uma importação em andamento.",
        409,
        "IMPORT_IN_PROGRESS",
        "req_conflict",
        undefined,
        { importId: existing.importId },
      ),
    );
    let helperSignal: AbortSignal | undefined;
    client.get.mockImplementation(
      (_importId: string, control?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          helperSignal = control?.signal;
          helperSignal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const view = render(
      <ImportUploadProvider client={client}>
        <Probe />
      </ImportUploadProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("false"),
    );
    let pending!: Promise<void>;
    await act(async () => {
      pending = currentContext().startUpload(
        new File(["x"], "argus_dump.sql.gz"),
        "2026-09-17",
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(helperSignal).toBeDefined());

    view.unmount();

    expect(helperSignal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("StrictMode executa um único bootstrap útil e limpa efeitos", async () => {
    vi.useFakeTimers();
    const client = clientFixture();
    const view = render(
      <StrictMode>
        <ImportUploadProvider client={client}>
          <Probe />
        </ImportUploadProvider>
      </StrictMode>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(client.list).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refresh da primeira página preserva histórico paginado, ordem e cursor final", async () => {
    const first = snapshot({ state: "READY", version: 3 });
    const second = snapshot({
      importId: "imp_01K5BB9WQ6EJ5V6TVCMSK74NQ4",
      state: "READY",
      version: 2,
    });
    const newest = snapshot({
      importId: "imp_01K5BB9WQ6EJ5V6TVCMSK74NQ5",
      state: "READY",
      version: 1,
    });
    const client = clientFixture();
    client.list
      .mockResolvedValueOnce({ items: [first], cursor: "after-first" })
      .mockResolvedValueOnce({ items: [second], cursor: null })
      .mockResolvedValueOnce({
        items: [newest, snapshot({ state: "READY", version: 4 })],
        cursor: "after-refreshed-first-page",
      });
    render(
      <ImportUploadProvider client={client}>
        <Probe />
      </ImportUploadProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("false"),
    );
    await act(async () => currentContext().loadMore());
    await act(async () => currentContext().refresh());

    expect(client.list).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId("ids").textContent?.split(",")).toEqual([
      newest.importId,
      first.importId,
      second.importId,
    ]);
    expect(screen.getByTestId("cursor")).toHaveTextContent("none");
  });

  it("insere uma nova reserva antes do histórico existente", async () => {
    const historical = snapshot({ state: "READY", version: 3 });
    const current = snapshot({
      importId: "imp_01K5BB9WQ6EJ5V6TVCMSK74NQ4",
      version: 1,
      createdAt: "2026-09-17T10:01:00.000Z",
      updatedAt: "2026-09-17T10:01:00.000Z",
    });
    const client = clientFixture([historical]);
    client.start.mockResolvedValue(current);
    render(
      <ImportUploadProvider
        client={client}
        uploadFile={vi.fn(() => new Promise<ImportSnapshot>(() => {}))}
      >
        <Probe />
      </ImportUploadProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("false"),
    );
    await act(async () => {
      await currentContext().startUpload(
        new File([new Uint8Array(40 * MiB)], "argus_dump.sql.gz"),
        "2026-09-17",
      );
    });

    expect(screen.getByTestId("ids").textContent?.split(",")).toEqual([
      current.importId,
      historical.importId,
    ]);
  });

  it("poll após loadMore atualiza o ativo sem descartar a página histórica", async () => {
    vi.useFakeTimers();
    const active = snapshot();
    const historical = snapshot({
      importId: "imp_01K5BB9WQ6EJ5V6TVCMSK74NQ4",
      state: "READY",
      version: 3,
    });
    const client = clientFixture();
    client.list
      .mockResolvedValueOnce({ items: [active], cursor: "after-active" })
      .mockResolvedValueOnce({ items: [historical], cursor: null });
    client.get
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce(
        snapshot({ state: "READY", version: 3, progress: { kind: "none" } }),
      );
    const view = render(
      <ImportUploadProvider client={client} pollIntervalMs={5_000}>
        <Probe />
      </ImportUploadProvider>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => currentContext().loadMore());
    await act(async () => vi.advanceTimersByTimeAsync(5_000));

    expect(screen.getByTestId("ids").textContent?.split(",")).toEqual([
      active.importId,
      historical.importId,
    ]);
    expect(screen.getByTestId("history-states")).toHaveTextContent(
      `${active.importId}:READY`,
    );
    expect(screen.getByTestId("cursor")).toHaveTextContent("none");
    view.unmount();
  });
});
