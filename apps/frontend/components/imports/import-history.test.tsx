import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ImportHistory } from "@/components/imports/import-history";
import type { ImportSnapshot } from "@/lib/imports/types";

const candidateVersion = `dsv_${"25b48847".padEnd(64, "a")}`;

const item = (overrides: Partial<ImportSnapshot> = {}): ImportSnapshot => ({
  importId: "imp_01K5BB9WQ6EJ5V6TVCMSK74NQ3",
  requestedBy: "usr_a",
  author: { id: "usr_a", name: "Ana", email: null },
  canManageUpload: false,
  fileName: "argus_dump.sql.gz",
  sizeBytes: 1024,
  snapshotExtractedOn: "2026-09-17",
  createdAt: "2026-09-17T10:00:00.000Z",
  updatedAt: "2026-09-17T10:01:00.000Z",
  state: "READY",
  version: 3,
  progress: { kind: "none" },
  candidateVersion,
  error: null,
  ...overrides,
});

describe("ImportHistory", () => {
  it("shows a short candidate label, activates it and marks the active dataset", async () => {
    const user = userEvent.setup();
    const activate = vi.fn(async () => {});
    const failed = item({
      importId: "imp_01K5BB9WQ6EJ5V6TVCMSK74NQ4",
      state: "FAILED",
      candidateVersion: null,
      error: {
        code: "WORKER_STOPPED",
        message: "O processamento foi interrompido.",
        requestId: "req_worker",
      },
    });
    const rendered = render(
      <ImportHistory
        imports={[failed, item()]}
        loading={false}
        loadingMore={false}
        nextCursor={null}
        onLoadMore={vi.fn()}
        activeDatasetVersion={null}
        activatingVersion={null}
        onActivate={activate}
      />,
    );
    expect(
      screen.getByText("Histórico compartilhado de importações do ARGUS"),
    ).toHaveClass("sr-only");
    expect(screen.getAllByRole("row")[1]).toHaveTextContent("Falhou");
    expect(screen.getByText("Versão 25b48847")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(candidateVersion);
    await user.click(
      screen.getByRole("button", { name: "Ativar versão 25b48847" }),
    );
    expect(activate).toHaveBeenCalledWith(item());
    expect(
      screen.getByText("O processamento foi interrompido.").parentElement,
    ).toHaveTextContent("WORKER_STOPPED");
    expect(
      screen.getByText("O processamento foi interrompido.").parentElement,
    ).toHaveTextContent("req_worker");

    rendered.rerender(
      <ImportHistory
        imports={[item()]}
        loading={false}
        loadingMore={false}
        nextCursor={null}
        onLoadMore={vi.fn()}
        activeDatasetVersion={candidateVersion}
        activatingVersion={null}
        onActivate={activate}
      />,
    );
    expect(screen.getByText("Dataset ativo")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Ativar versão/ }),
    ).not.toBeInTheDocument();
  });

  it("mostra fallback terminal, vazio, skeleton e paginação sem duplicar chamada", async () => {
    const user = userEvent.setup();
    const loadMore = vi.fn(async () => {});
    const { rerender } = render(
      <ImportHistory
        imports={[]}
        loading
        onLoadMore={loadMore}
        loadingMore={false}
        nextCursor={null}
      />,
    );
    expect(
      screen.getByLabelText("Carregando histórico de importações"),
    ).toBeInTheDocument();
    rerender(
      <ImportHistory
        imports={[]}
        loading={false}
        onLoadMore={loadMore}
        loadingMore={false}
        nextCursor={null}
      />,
    );
    expect(
      screen.getByText("Nenhuma importação concluída ainda."),
    ).toBeInTheDocument();
    rerender(
      <ImportHistory
        imports={[
          item({ state: "FAILED", candidateVersion: null, error: null }),
        ]}
        loading={false}
        onLoadMore={loadMore}
        loadingMore={false}
        nextCursor="next"
      />,
    );
    expect(
      screen.getByText(
        /A importação falhou. Atualize a página ou contate o suporte/,
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Carregar mais" }));
    expect(loadMore).toHaveBeenCalledTimes(1);
    rerender(
      <ImportHistory
        imports={[item()]}
        loading={false}
        onLoadMore={loadMore}
        loadingMore
        nextCursor="next"
      />,
    );
    expect(
      screen.getByRole("button", { name: "Carregar mais" }),
    ).toBeDisabled();
  });
});
