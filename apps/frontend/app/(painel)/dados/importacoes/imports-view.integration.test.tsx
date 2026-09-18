import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";

import { ImportsView } from "@/app/(painel)/dados/importacoes/imports-view";
import {
  ImportUploadProvider,
  useImportUpload,
  type ImportUploadClient,
  type ImportUploadContextValue,
  type ImportUploadRunner,
} from "@/components/imports/import-upload-provider";
import { ApiError } from "@/lib/data/client";
import type { ImportSnapshot } from "@/lib/imports/types";

const active = (overrides: Partial<ImportSnapshot> = {}): ImportSnapshot => ({
  importId: "imp_01K5BB9WQ6EJ5V6TVCMSK74NQ3",
  requestedBy: "usr_owner",
  author: { id: "usr_owner", name: "Maria", email: null },
  canManageUpload: true,
  fileName: "argus_dump.sql.gz",
  sizeBytes: 4,
  snapshotExtractedOn: "2026-09-17",
  createdAt: "2026-09-17T10:00:00.000Z",
  updatedAt: "2026-09-17T10:00:00.000Z",
  state: "UPLOADING",
  version: 1,
  progress: { kind: "bytes", completedBytes: 0, totalBytes: 4 },
  candidateVersion: null,
  error: null,
  ...overrides,
});

function clientFixture(): ImportUploadClient {
  return {
    list: vi.fn(async () => ({ items: [], cursor: null })),
    get: vi.fn(async () => active()),
    start: vi.fn(async () => active()),
    listParts: vi.fn(async () => []),
    signParts: vi.fn(async () => []),
    restart: vi.fn(async () => active()),
    complete: vi.fn(async () => active({ state: "UPLOADED", version: 2 })),
  };
}

let latest: ImportUploadContextValue | null = null;

function CaptureContext() {
  const context = useImportUpload();
  useEffect(() => {
    latest = context;
  }, [context]);
  return null;
}

async function ready() {
  await waitFor(() => expect(latest?.loading).toBe(false));
  if (!latest) throw new Error("Provider não publicou contexto.");
  return latest;
}

describe("ImportsView com provider real", () => {
  it("preserva falha física e mostra separadamente falha posterior de leitura", async () => {
    const client = clientFixture();
    const putError = new ApiError(
      "Falha segura no PUT.",
      503,
      "DATA_UNAVAILABLE",
      "req_put",
      undefined,
      { url: "https://physical-secret.test" },
    );
    const readError = new ApiError(
      "Leitura indisponível.",
      503,
      "DATA_UNAVAILABLE",
      "req_read",
    );
    const uploadFile = vi
      .fn<ImportUploadRunner>()
      .mockRejectedValueOnce(putError)
      .mockImplementationOnce(() => new Promise<ImportSnapshot>(() => {}));
    render(
      <ImportUploadProvider
        client={client}
        uploadFile={uploadFile}
        pollIntervalMs={60_000}
      >
        <CaptureContext />
        <ImportsView />
      </ImportUploadProvider>,
    );
    const context = await ready();

    await act(async () => {
      await context.startUpload(
        new File(["dump"], "argus_dump.sql.gz"),
        "2026-09-17",
      );
    });
    expect(
      await screen.findByText("O upload foi interrompido"),
    ).toBeInTheDocument();
    vi.mocked(client.get).mockRejectedValueOnce(readError);
    await act(async () => {
      await latest?.refresh().catch(() => undefined);
    });

    expect(
      screen.getByText("O upload foi interrompido").parentElement,
    ).toHaveTextContent("req_put");
    expect(
      screen.getByText("Não foi possível atualizar as importações")
        .parentElement,
    ).toHaveTextContent("req_read");
    expect(
      screen.getByRole("button", { name: "Tentar novamente" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Tentar atualizar" }),
    ).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("physical-secret");
    expect(latest?.transferError?.requestId).toBe("req_put");
    expect(latest?.readError?.requestId).toBe("req_read");

    vi.mocked(client.get).mockResolvedValueOnce(active());
    await act(async () => {
      await latest?.refresh();
    });
    expect(
      screen.queryByText("Não foi possível atualizar as importações"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("O upload foi interrompido").parentElement,
    ).toHaveTextContent("req_put");
    expect(latest?.transferError?.requestId).toBe("req_put");
    expect(latest?.readError).toBeNull();

    vi.mocked(client.get).mockRejectedValueOnce(
      new ApiError(
        "Nova falha de leitura.",
        503,
        "DATA_UNAVAILABLE",
        "req_read_2",
      ),
    );
    await act(async () => {
      await latest?.refresh().catch(() => undefined);
    });
    expect(
      screen.getByText("Não foi possível atualizar as importações")
        .parentElement,
    ).toHaveTextContent("req_read_2");
    expect(latest?.transferError?.requestId).toBe("req_put");
    expect(latest?.readError?.requestId).toBe("req_read_2");
    await act(async () => {
      await latest?.retryUpload();
    });
    expect(
      screen.queryByText("O upload foi interrompido"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Não foi possível atualizar as importações")
        .parentElement,
    ).toHaveTextContent("req_read_2");
    expect(latest?.transferError).toBeNull();
    expect(latest?.readError?.requestId).toBe("req_read_2");
    expect(uploadFile).toHaveBeenCalledTimes(2);
  });

  it("limpa warning de conflito quando o polling publica terminal", async () => {
    const client = clientFixture();
    const concurrent = active({ canManageUpload: false });
    const terminal = active({
      canManageUpload: false,
      state: "READY",
      version: 2,
      progress: { kind: "none" },
      candidateVersion: `dsv_${"a".repeat(64)}`,
    });
    vi.mocked(client.start).mockRejectedValueOnce(
      new ApiError(
        "Já existe uma importação em andamento.",
        409,
        "IMPORT_IN_PROGRESS",
        "req_conflict",
        undefined,
        { importId: concurrent.importId },
      ),
    );
    vi.mocked(client.get)
      .mockResolvedValueOnce(concurrent)
      .mockRejectedValueOnce(
        new ApiError(
          "Polling indisponível.",
          503,
          "DATA_UNAVAILABLE",
          "req_poll",
        ),
      )
      .mockResolvedValueOnce(terminal);
    const uploadFile = vi.fn<ImportUploadRunner>();
    render(
      <ImportUploadProvider
        client={client}
        uploadFile={uploadFile}
        pollIntervalMs={60_000}
      >
        <CaptureContext />
        <ImportsView />
      </ImportUploadProvider>,
    );
    const context = await ready();

    await act(async () => {
      await context.startUpload(
        new File(["dump"], "argus_dump.sql.gz"),
        "2026-09-17",
      );
    });
    expect(
      screen.getByText("Outra importação já está em andamento"),
    ).toBeInTheDocument();
    expect(uploadFile).not.toHaveBeenCalled();

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(
      await screen.findByText("Não foi possível atualizar as importações"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Outra importação já está em andamento"),
    ).toBeInTheDocument();
    expect(latest?.conflict?.error.requestId).toBe("req_conflict");
    expect(latest?.readError?.requestId).toBe("req_poll");

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    await waitFor(() => expect(latest?.activeImport).toBeNull());
    expect(latest?.conflict).toBeNull();
    expect(latest?.readError).toBeNull();
    expect(
      screen.queryByText("Outra importação já está em andamento"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Não foi possível atualizar as importações"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Tentar atualizar" }),
    ).not.toBeInTheDocument();
  });
});
