import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ImportStatusCard } from "@/components/imports/import-status-card";
import type { ImportSnapshot } from "@/lib/imports/types";

const MiB = 1024 ** 2;
const snapshot = (overrides: Partial<ImportSnapshot> = {}): ImportSnapshot => ({
  importId: "imp_01K5BB9WQ6EJ5V6TVCMSK74NQ3",
  requestedBy: "usr_owner",
  author: { id: "usr_owner", name: "Maria", email: null },
  canManageUpload: true,
  fileName: "argus_dump.sql.gz",
  sizeBytes: 40 * MiB,
  snapshotExtractedOn: "2026-09-17",
  createdAt: "2026-09-17T10:00:00.000Z",
  updatedAt: "2026-09-17T10:01:00.000Z",
  state: "UPLOADING",
  version: 2,
  progress: { kind: "bytes", completedBytes: 16 * MiB, totalBytes: 40 * MiB },
  candidateVersion: null,
  error: null,
  ...overrides,
});

describe("ImportStatusCard", () => {
  it("mostra progresso determinístico do owner com ARIA e bytes únicos", () => {
    render(
      <ImportStatusCard
        snapshot={snapshot()}
        transfer="uploading"
        uploadProgress={{
          confirmedBytes: 16 * MiB,
          inFlightBytes: 8 * MiB,
          totalBytes: 40 * MiB,
        }}
        needsFileReselection={false}
        onResume={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    const bar = screen.getByRole("progressbar", {
      name: "Progresso do upload",
    });
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    expect(bar).toHaveAttribute("aria-valuenow", "60");
    expect(bar).toHaveAttribute("aria-valuetext", "24 MiB de 40 MiB enviados");
  });

  it("non-owner usa somente progresso público e não recebe ações físicas", () => {
    render(
      <ImportStatusCard
        snapshot={snapshot({ canManageUpload: false })}
        transfer="failed"
        uploadProgress={{
          confirmedBytes: 32 * MiB,
          inFlightBytes: 8 * MiB,
          totalBytes: 40 * MiB,
        }}
        needsFileReselection
        onResume={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "40",
    );
    expect(
      screen.getByText(/Você pode acompanhar o progresso nesta página/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/retomar/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Tentar novamente" }),
    ).not.toBeInTheDocument();
  });

  it("stage usa lista/counters reais e nunca inventa percentual", () => {
    const { container } = render(
      <ImportStatusCard
        snapshot={snapshot({
          state: "PROCESSING",
          progress: {
            kind: "stage",
            stage: "INGESTING",
            recordsRead: 10,
            recordsWritten: 7,
            recordsRejected: 1,
          },
        })}
        transfer="idle"
        uploadProgress={null}
        needsFileReselection={false}
        onResume={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("list", { name: "Etapas do processamento" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Ingerindo registros")).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect(screen.getByText("Registros lidos").parentElement).toHaveTextContent(
      "10",
    );
    expect(
      screen.getByText("Registros gravados").parentElement,
    ).toHaveTextContent("7");
    expect(
      screen.getByText("Registros rejeitados").parentElement,
    ).toHaveTextContent("1");
    expect(container).not.toHaveTextContent("%");
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("mostra o fluxo canônico e a materialização ignorada por política", () => {
    render(
      <ImportStatusCard
        snapshot={snapshot({
          state: "PROCESSING",
          progress: {
            kind: "stage",
            stage: "MATERIALIZING_HOT",
            substage: "SKIPPED_BY_POLICY",
            recordsRead: 10,
            recordsWritten: 10,
            recordsRejected: 0,
            unitsCompleted: 0,
            unitsTotal: 0,
            unitLabel: "datasets",
          },
        })}
        transfer="idle"
        uploadProgress={null}
        needsFileReselection={false}
        onResume={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText("Extraindo registros")).toBeInTheDocument();
    expect(
      screen.getByText("Publicando arquivos canônicos"),
    ).toBeInTheDocument();
    expect(screen.getByText("Ignorado por política")).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect(screen.getByText("Finalizando candidato")).toBeInTheDocument();
  });

  it.each([
    ["ARCHIVING", "Publicando arquivos canônicos"],
    ["PROJECTING", "Gerando projeções"],
  ] as const)(
    "apresenta %s sem inventar a ordem do pipeline privado",
    (stage, label) => {
      render(
        <ImportStatusCard
          snapshot={snapshot({
            state: "PROCESSING",
            progress: {
              kind: "stage",
              stage,
              recordsRead: 10,
              recordsWritten: 10,
              recordsRejected: 0,
            },
          })}
          transfer="idle"
          uploadProgress={null}
          needsFileReselection={false}
          onResume={vi.fn()}
          onRetry={vi.fn()}
        />,
      );

      expect(screen.getByText(label)).toHaveAttribute("aria-current", "step");
      expect(
        screen.getByText(
          "Etapa compartilhada pelos fluxos legado e canônico; a ordem completa não está disponível.",
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText("Ingerindo registros")).not.toBeInTheDocument();
      expect(screen.queryByText("Extraindo registros")).not.toBeInTheDocument();
      if (stage === "ARCHIVING") {
        expect(screen.queryByText("Gerando projeções")).not.toBeInTheDocument();
      } else {
        expect(
          screen.queryByText("Publicando arquivos canônicos"),
        ).not.toBeInTheDocument();
      }
    },
  );

  it("mostra heartbeat, estado das etapas e percentual real da ingestão", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-17T10:01:30.000Z"));
    try {
      render(
        <ImportStatusCard
          snapshot={snapshot({
            state: "PROCESSING",
            progress: {
              kind: "stage",
              stage: "INGESTING",
              stageStartedAt: "2026-09-17T10:00:00.000Z",
              heartbeatAt: "2026-09-17T10:01:00.000Z",
              recordsRead: 125,
              recordsWritten: 120,
              recordsRejected: 5,
              recordsTotal: 1000,
              currentDataset: "signal_bucket",
              datasetsCompleted: 2,
              datasetsTotal: 23,
            },
          })}
          transfer="idle"
          uploadProgress={null}
          needsFileReselection={false}
          onResume={vi.fn()}
          onRetry={vi.fn()}
        />,
      );

      expect(
        screen.getByText("Restaurando banco").parentElement,
      ).toHaveTextContent("Concluída");
      expect(
        screen.getByText("Ingerindo registros").parentElement,
      ).toHaveTextContent("Em andamento");
      expect(
        screen.getByText("Gerando projeções").parentElement,
      ).toHaveTextContent("Aguardando");
      expect(screen.getByText(/signal_bucket/)).toBeInTheDocument();
      expect(
        screen.getByText(/2 de 23 datasets concluídos/),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("progressbar", { name: "Progresso dos registros" }),
      ).toHaveAttribute("aria-valuenow", "12");
      expect(screen.getByText("Worker ativo")).toBeInTheDocument();
      expect(screen.getByText(/Última atividade/)).toHaveTextContent(
        "17/09/2026",
      );
      expect(screen.getByText(/Etapa iniciada/)).toHaveTextContent(
        "17/09/2026",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("avisa sobre heartbeat antigo sem declarar falha", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-17T10:10:00.000Z"));
    try {
      render(
        <ImportStatusCard
          snapshot={snapshot({
            state: "PROCESSING",
            progress: {
              kind: "stage",
              stage: "PROJECTING",
              stageStartedAt: "2026-09-17T10:00:00.000Z",
              heartbeatAt: "2026-09-17T10:05:00.000Z",
              recordsRead: 1000,
              recordsWritten: 1000,
              recordsRejected: 0,
              recordsTotal: 1000,
              currentDataset: null,
              datasetsCompleted: 23,
              datasetsTotal: 23,
            },
          })}
          transfer="idle"
          uploadProgress={null}
          needsFileReselection={false}
          onResume={vi.fn()}
          onRetry={vi.fn()}
        />,
      );
      expect(screen.getByText("Sem atualização recente")).toBeInTheDocument();
      expect(screen.queryByText("Falhou")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("owner após reload valida nome/tamanho antes de retomar", async () => {
    const user = userEvent.setup({ applyAccept: false });
    const resume = vi.fn(async () => {});
    render(
      <ImportStatusCard
        snapshot={snapshot()}
        transfer="idle"
        uploadProgress={null}
        needsFileReselection
        onResume={resume}
        onRetry={vi.fn()}
      />,
    );
    const input = screen.getByLabelText("Selecionar arquivo para retomar");
    await user.upload(input, new File(["bad"], "outro.zip"));
    expect(resume).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "O nome e o tamanho precisam corresponder ao arquivo do envio original.",
      ),
    ).toBeInTheDocument();
    const valid = new File(["x"], "argus_dump.sql.gz");
    Object.defineProperty(valid, "size", { value: 40 * MiB });
    await user.upload(input, valid);
    expect(resume).toHaveBeenCalledWith(valid);
  });

  it("FAILED mostra somente erro seguro e requestId", () => {
    render(
      <ImportStatusCard
        snapshot={snapshot({
          state: "FAILED",
          progress: { kind: "none" },
          error: {
            code: "MYSQL_CONNECTION_LOST",
            message:
              "SELECT cursor FROM mysql.internal WHERE key = 's3://private/key'",
            requestId: "req_failed",
            stage: "INGESTING",
            retryable: true,
            attempt: 4,
            maxAttempts: 4,
          },
        })}
        transfer="idle"
        uploadProgress={null}
        needsFileReselection={false}
        onResume={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/reconexão/i);
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      /SELECT|cursor|mysql\.internal|s3:\/\//i,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("req_failed");
  });

  it("READY mostra uma versão curta em vez do identificador técnico completo", () => {
    const candidateVersion = `dsv_${"25b48847".padEnd(64, "a")}`;
    render(
      <ImportStatusCard
        snapshot={snapshot({
          state: "READY",
          progress: { kind: "none" },
          candidateVersion,
        })}
        transfer="idle"
        uploadProgress={null}
        needsFileReselection={false}
        onResume={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Versão 25b48847");
    expect(screen.getByRole("status")).not.toHaveTextContent(candidateVersion);
  });
});
