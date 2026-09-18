import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { ImportUploadDialog } from "@/components/imports/import-upload-dialog";
import { ApiError } from "@/lib/data/client";

const GiB = 1024 ** 3;

function sizedFile(name: string, size: number, type = "") {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { configurable: true, value: size });
  return file;
}

function Harness({
  startUpload = vi.fn(async () => {}),
}: {
  startUpload?: (file: File, date: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={triggerRef} onClick={() => setOpen(true)}>
        Abrir importação
      </button>
      <ImportUploadDialog
        open={open}
        onClose={() => setOpen(false)}
        onStartUpload={startUpload}
        triggerRef={triggerRef}
        now={new Date(2026, 8, 17, 23, 30)}
      />
    </>
  );
}

async function openDialog(
  startUpload?: (file: File, date: string) => Promise<void>,
) {
  const user = userEvent.setup({ applyAccept: false });
  render(<Harness startUpload={startUpload} />);
  const trigger = screen.getByRole("button", { name: "Abrir importação" });
  await user.click(trigger);
  return { user, trigger };
}

describe("ImportUploadDialog", () => {
  it("expõe copy, limites e data civil local editável", async () => {
    const { user } = await openDialog();
    expect(
      screen.getByRole("dialog", { name: "Importar dump do ARGUS" }),
    ).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText(/Formatos aceitos:/)).toHaveTextContent(
      "Formatos aceitos: argus_dump.sql.gz ou arquivo .zip contendo exclusivamente argus_dump.sql.gz",
    );
    for (const text of [
      "GZIP: até 5 GiB",
      "ZIP: até 10 GiB",
      "GZIP dentro do ZIP: até 5 GiB",
      "Expansão máxima do ZIP: 100:1",
      "SQL descompactado: até 100 GiB",
    ])
      expect(screen.getByText(text)).toBeInTheDocument();
    const date = screen.getByLabelText("Data de extração do dump");
    expect(date).toHaveValue("2026-09-17");
    await user.clear(date);
    await user.type(date, "2026-09-16");
    expect(date).toHaveValue("2026-09-16");
    expect(
      screen.getByText(/data em que o dump foi extraído na origem/i),
    ).toBeInTheDocument();
  });

  it.each([
    [
      "nome inválido",
      sizedFile("dump.sql.gz", 10),
      /Selecione argus_dump.sql.gz ou um arquivo .zip/,
    ],
    ["vazio", sizedFile("argus_dump.sql.gz", 0), /não pode estar vazio/i],
    [
      "gzip grande",
      sizedFile("argus_dump.sql.gz", 5 * GiB + 1),
      /GZIP deve ter até 5 GiB/,
    ],
    [
      "zip grande",
      sizedFile("dump.zip", 10 * GiB + 1),
      /ZIP deve ter até 10 GiB/,
    ],
    [
      "zip com path",
      sizedFile("pasta/dump.zip", 10),
      /Selecione argus_dump.sql.gz ou um arquivo .zip/,
    ],
  ])(
    "rejeita arquivo %s por nome/tamanho, não MIME",
    async (_label, file, message) => {
      const { user } = await openDialog();
      const input = screen.getByLabelText("Arquivo do dump");
      await user.upload(input, file);
      await user.click(
        screen.getByRole("button", { name: "Revisar importação" }),
      );
      expect(screen.getByText(message)).toBeInTheDocument();
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(
        screen.queryByRole("heading", { name: "Confirmar importação" }),
      ).not.toBeInTheDocument();
    },
  );

  it("valida data obrigatória e aceita MIME vazio quando nome e tamanho são válidos", async () => {
    const { user } = await openDialog();
    const fileInput = screen.getByLabelText("Arquivo do dump");
    await user.upload(fileInput, sizedFile("argus_dump.sql.gz", 1024, ""));
    await user.clear(screen.getByLabelText("Data de extração do dump"));
    await user.click(
      screen.getByRole("button", { name: "Revisar importação" }),
    );
    expect(
      screen.getByText("Informe a data de extração do dump."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Data de extração do dump")).toHaveFocus();
  });

  it("revisa sem reservar, preserva valores ao voltar e confirma uma vez", async () => {
    let release!: () => void;
    const start = vi.fn(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const { user } = await openDialog(start);
    await user.upload(
      screen.getByLabelText("Arquivo do dump"),
      sizedFile("snapshot.zip", 2 * GiB),
    );
    await user.click(
      screen.getByRole("button", { name: "Revisar importação" }),
    );
    expect(start).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: "Confirmar importação" }),
    ).toHaveFocus();
    expect(screen.getByText("snapshot.zip")).toBeInTheDocument();
    expect(screen.getByText("2 GiB")).toBeInTheDocument();
    expect(screen.getByText("17/09/2026")).toBeInTheDocument();
    expect(
      screen.getByText(/reservará a única vaga global/i),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Voltar" }));
    expect(
      screen.getByText("Arquivo selecionado: snapshot.zip"),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Revisar importação" }),
    );
    const confirm = screen.getByRole("button", {
      name: "Confirmar e iniciar upload",
    });
    await user.click(confirm);
    await user.click(confirm);
    expect(start).toHaveBeenCalledTimes(1);
    expect(confirm).toBeDisabled();
    await user.keyboard("{Escape}");
    await user.click(screen.getByTestId("import-dialog-backdrop"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await act(async () => release());
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("fecha também pelo botão Cancelar e pelo X", async () => {
    const { user, trigger } = await openDialog();
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Fechar importação" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("mantém aberto e mostra mensagem/requestId seguros quando a reserva falha", async () => {
    const start = vi.fn(async () => {
      throw new ApiError(
        "Não foi possível reservar.",
        503,
        "DATA_UNAVAILABLE",
        "req_safe",
        undefined,
        { uploadId: "secret" },
      );
    });
    const { user } = await openDialog(start);
    await user.upload(
      screen.getByLabelText("Arquivo do dump"),
      sizedFile("argus_dump.sql.gz", 1024),
    );
    await user.click(
      screen.getByRole("button", { name: "Revisar importação" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Confirmar e iniciar upload" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Não foi possível reservar.",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("req_safe");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("secret");
  });

  it("fecha por Escape/backdrop, prende Tab e devolve foco ao trigger", async () => {
    const { user, trigger } = await openDialog();
    const dialog = screen.getByRole("dialog");
    expect(screen.getByLabelText("Arquivo do dump")).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");
    await user.tab({ shift: true });
    expect(
      screen.getByRole("button", { name: "Fechar importação" }),
    ).toHaveFocus();
    await user.tab({ shift: true });
    expect(
      screen.getByRole("button", { name: "Revisar importação" }),
    ).toHaveFocus();
    await user.tab();
    expect(
      screen.getByRole("button", { name: "Fechar importação" }),
    ).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText("Arquivo do dump")).toHaveFocus();
    await user.click(dialog);
    expect(dialog).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(document.body.style.overflow).toBe("");

    await user.click(trigger);
    const backdrop = screen.getByTestId("import-dialog-backdrop");
    await user.click(backdrop);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
