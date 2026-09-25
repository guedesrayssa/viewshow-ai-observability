import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ImportUploadContextValue } from "@/components/imports/import-upload-provider";
import type { ImportSnapshot } from "@/lib/imports/types";

const mocked = vi.hoisted(() => ({
  context: null as ImportUploadContextValue | null,
}));
vi.mock("@/components/imports/import-upload-provider", async () => {
  const actual = await vi.importActual<
    typeof import("@/components/imports/import-upload-provider")
  >("@/components/imports/import-upload-provider");
  return { ...actual, useImportUpload: () => mocked.context };
});

import { ImportsView } from "@/app/(painel)/dados/importacoes/imports-view";
import { ApiError } from "@/lib/data/client";

const active = (overrides: Partial<ImportSnapshot> = {}): ImportSnapshot => ({
  importId: "imp_01K5BB9WQ6EJ5V6TVCMSK74NQ3",
  requestedBy: "usr_owner",
  author: { id: "usr_owner", name: "Maria", email: null },
  canManageUpload: true,
  fileName: "argus_dump.sql.gz",
  sizeBytes: 1024,
  snapshotExtractedOn: "2026-09-17",
  createdAt: "2026-09-17T10:00:00.000Z",
  updatedAt: "2026-09-17T10:00:00.000Z",
  state: "UPLOADING",
  version: 1,
  progress: { kind: "bytes", completedBytes: 0, totalBytes: 1024 },
  candidateVersion: null,
  error: null,
  ...overrides,
});

function context(
  overrides: Partial<ImportUploadContextValue> = {},
): ImportUploadContextValue {
  return {
    imports: [],
    activeImport: null,
    activeDatasetVersion: null,
    activatingVersion: null,
    nextCursor: null,
    transfer: "idle",
    uploadProgress: null,
    needsFileReselection: false,
    readError: null,
    transferError: null,
    conflict: null,
    loading: false,
    loadingMore: false,
    startUpload: vi.fn(async () => {}),
    resumeUpload: vi.fn(async () => {}),
    retryUpload: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    loadMore: vi.fn(async () => {}),
    activate: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("ImportsView", () => {
  beforeEach(() => {
    mocked.context = context();
    window.history.replaceState(null, "", "/dados/importacoes");
  });

  it("abre o dialog sem ativa e não cria refresh/polling próprio", async () => {
    const user = userEvent.setup();
    render(<ImportsView />);
    await user.click(
      screen.getByRole("button", { name: "Importar dump do ARGUS" }),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(mocked.context?.refresh).not.toHaveBeenCalled();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(mocked.context?.refresh).not.toHaveBeenCalled();
    expect(
      screen.queryByText(/ativar|trocar dataset/i),
    ).not.toBeInTheDocument();
  });

  it("confirms the global effect before activating a READY candidate", async () => {
    const user = userEvent.setup();
    const activate = vi.fn(async () => {});
    const candidate = active({
      state: "READY",
      progress: { kind: "none" },
      candidateVersion: `dsv_${"25b48847".padEnd(64, "a")}`,
      canManageUpload: false,
    });
    mocked.context = context({ imports: [candidate], activate });
    render(<ImportsView />);

    await user.click(
      screen.getByRole("button", { name: "Ativar versão 25b48847" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Ativar dataset" }),
    ).toHaveTextContent("todos os painéis");
    await user.click(
      screen.getByRole("button", { name: "Confirmar ativação" }),
    );

    await waitFor(() => expect(activate).toHaveBeenCalledWith(candidate.importId));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("explica a trava global, ancora/foca o ativo abaixo da topbar e não o duplica", async () => {
    const user = userEvent.setup();
    const current = active();
    const historical = active({
      importId: "imp_01K5BB9WQ6EJ5V6TVCMSK74NQ4",
      state: "READY",
      progress: { kind: "none" },
      candidateVersion: `dsv_${"b".repeat(64)}`,
    });
    mocked.context = context({
      activeImport: current,
      imports: [current, historical],
    });
    render(<ImportsView />);
    expect(
      screen.getByRole("button", { name: "Importar dump do ARGUS" }),
    ).toBeDisabled();
    const link = screen.getByRole("link", {
      name: "Ver importação em andamento",
    });
    expect(link).toHaveAttribute("href", "#importacao-atual");
    const section = document.getElementById("importacao-atual");
    expect(section).toHaveAttribute("tabindex", "-1");
    expect(section).toHaveClass("scroll-mt-16");
    expect(section).not.toHaveClass("scroll-mt-6");
    await user.click(link);
    expect(window.location.hash).toBe("#importacao-atual");
    expect(section).toHaveFocus();
    expect(screen.getAllByText("argus_dump.sql.gz")).toHaveLength(2);
  });

  it("non-owner acompanha sem ações físicas", () => {
    mocked.context = context({
      activeImport: active({ canManageUpload: false }),
      imports: [active({ canManageUpload: false })],
      needsFileReselection: true,
    });
    render(<ImportsView />);
    expect(
      screen.getByText(/Você pode acompanhar o progresso nesta página/),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Selecionar arquivo para retomar"),
    ).not.toBeInTheDocument();
  });

  it("trata conflito global como warning contextual sem refresh ou detalhe físico", async () => {
    const user = userEvent.setup();
    const conflict = new ApiError(
      "Outra pessoa iniciou uma importação.",
      409,
      "IMPORT_IN_PROGRESS",
      "req_conflict",
      undefined,
      { importId: active().importId, uploadId: "physical-secret" },
    );
    mocked.context = context({
      activeImport: active({ canManageUpload: false }),
      imports: [active({ canManageUpload: false })],
      conflict: { importId: active().importId, error: conflict },
    });
    render(<ImportsView />);

    const warning = screen
      .getByText("Outra importação já está em andamento")
      .closest('[role="status"]');
    expect(warning).toHaveTextContent("Outra pessoa iniciou uma importação.");
    expect(warning).toHaveTextContent("req_conflict");
    expect(warning).not.toHaveTextContent("physical-secret");
    const link = screen.getByRole("link", {
      name: "Ver importação em andamento",
    });
    expect(link).toHaveAttribute("href", "#importacao-atual");
    expect(
      screen.queryByText("Não foi possível atualizar as importações"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Tentar atualizar" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("link", { name: "Ver importação em andamento" }),
    ).toHaveLength(1);
    await user.click(link);
    expect(window.location.hash).toBe("#importacao-atual");
    expect(document.getElementById("importacao-atual")).toHaveFocus();
  });

  it("falha de leitura continua crítica e oferece refresh persistente", async () => {
    const user = userEvent.setup();
    const refresh = vi.fn(async () => {});
    mocked.context = context({
      readError: new ApiError(
        "Falha segura",
        503,
        "DATA_UNAVAILABLE",
        "req_ui",
      ),
      refresh,
    });
    render(<ImportsView />);
    expect(screen.getByRole("alert")).toHaveTextContent("req_ui");
    await user.click(screen.getByRole("button", { name: "Tentar atualizar" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("não apresenta histórico vazio quando a sessão expirou", () => {
    mocked.context = context({
      readError: new ApiError(
        "Sessão inválida.",
        401,
        "UNAUTHENTICATED",
        "req_expired",
      ),
    });

    render(<ImportsView />);

    expect(screen.getByRole("alert")).toHaveTextContent("Sessão inválida.");
    expect(
      screen.queryByText("Nenhuma importação concluída ainda."),
    ).not.toBeInTheDocument();
  });

  it("expõe uma única seção intitulada Histórico de importações", () => {
    render(<ImportsView />);

    expect(
      screen.getAllByRole("heading", { name: "Histórico de importações" }),
    ).toHaveLength(1);
    expect(
      screen.getByRole("region", { name: "Histórico de importações" }),
    ).toBeInTheDocument();
  });

  it("falha local de upload aparece somente no cartão e some quando o provider limpa", () => {
    const current = active();
    mocked.context = context({
      activeImport: current,
      imports: [current],
      transfer: "failed",
      transferError: new ApiError(
        "Não foi possível continuar o upload.",
        503,
        "DATA_UNAVAILABLE",
        "req_upload",
      ),
    });
    const rendered = render(<ImportsView />);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Não foi possível continuar o upload.",
    );
    expect(
      screen.queryByText("Não foi possível atualizar as importações"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Tentar atualizar" }),
    ).not.toBeInTheDocument();

    mocked.context = context({ activeImport: current, imports: [current] });
    rendered.rerender(<ImportsView />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("remove o warning de conflito quando o provider limpa o erro", () => {
    const current = active({ canManageUpload: false });
    mocked.context = context({
      activeImport: current,
      imports: [current],
      conflict: {
        importId: current.importId,
        error: new ApiError(
          "Conflito global.",
          409,
          "IMPORT_IN_PROGRESS",
          "req_conflict",
        ),
      },
    });
    const rendered = render(<ImportsView />);
    expect(
      screen.getByText("Outra importação já está em andamento"),
    ).toBeInTheDocument();

    mocked.context = context({ activeImport: current, imports: [current] });
    rendered.rerender(<ImportsView />);
    expect(
      screen.queryByText("Outra importação já está em andamento"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Já existe uma importação em andamento."),
    ).toBeInTheDocument();
  });

  it("fecha após a reserva e reencontra o upload do provider após navegar", async () => {
    const user = userEvent.setup();
    const startUpload = vi.fn(async () => {});
    mocked.context = context({ startUpload });
    const rendered = render(<ImportsView />);

    await user.click(
      screen.getByRole("button", { name: "Importar dump do ARGUS" }),
    );
    await user.upload(
      screen.getByLabelText("Arquivo do dump"),
      new File(["dump"], "argus_dump.sql.gz"),
    );
    await user.click(
      screen.getByRole("button", { name: "Revisar importação" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Confirmar e iniciar upload" }),
    );

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(startUpload).toHaveBeenCalledWith(
      expect.objectContaining({ name: "argus_dump.sql.gz" }),
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    );

    mocked.context = context({
      activeImport: active(),
      imports: [active()],
      transfer: "uploading",
      uploadProgress: {
        confirmedBytes: 256,
        inFlightBytes: 256,
        totalBytes: 1024,
      },
    });
    rendered.unmount();
    render(<ImportsView />);
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "50",
    );
    expect(
      screen.getByRole("button", { name: "Importar dump do ARGUS" }),
    ).toBeDisabled();
  });
});
