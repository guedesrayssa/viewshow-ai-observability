"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import {
  formatBytes,
  formatCivilDate,
  localIsoDate,
} from "@/components/imports/import-presentation";
import { Alert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { FieldError, FieldHint, Input, Label } from "@/components/ui/input";
import { XIcon } from "@/components/ui/icons";
import { ApiError } from "@/lib/data/client";

const GZIP_MAX_BYTES = 5 * 1024 ** 3;
const ZIP_MAX_BYTES = 10 * 1024 ** 3;
const ZIP_FILE_NAME = /^[^/\\]{1,251}\.zip$/i;
const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

type DialogErrors = { file?: string; date?: string };

export type ImportUploadDialogProps = {
  open: boolean;
  onClose(): void;
  onStartUpload(file: File, snapshotExtractedOn: string): Promise<void>;
  triggerRef: RefObject<HTMLElement | null>;
  now?: Date;
};

function fileError(file: File | null): string | undefined {
  if (!file) return "Selecione o arquivo do dump.";
  if (file.name !== file.name.trim())
    return "Selecione argus_dump.sql.gz ou um arquivo .zip.";
  const isGzip = file.name === "argus_dump.sql.gz";
  const isZip = ZIP_FILE_NAME.test(file.name);
  if (!isGzip && !isZip)
    return "Selecione argus_dump.sql.gz ou um arquivo .zip.";
  if (file.size <= 0) return "O arquivo não pode estar vazio.";
  if (isGzip && file.size > GZIP_MAX_BYTES)
    return "O arquivo GZIP deve ter até 5 GiB.";
  if (isZip && file.size > ZIP_MAX_BYTES)
    return "O arquivo ZIP deve ter até 10 GiB.";
  return undefined;
}

function dateError(value: string): string | undefined {
  if (!value) return "Informe a data de extração do dump.";
  try {
    formatCivilDate(value);
    return undefined;
  } catch {
    return "Informe uma data de extração válida.";
  }
}

export function ImportUploadDialog({
  open,
  onClose,
  onStartUpload,
  triggerRef,
  now,
}: ImportUploadDialogProps) {
  const today = localIsoDate(now ?? new Date());
  const titleId = useId();
  const descriptionId = useId();
  const fileId = useId();
  const fileHintId = `${fileId}-hint`;
  const fileErrorId = `${fileId}-error`;
  const dateId = useId();
  const dateHintId = `${dateId}-hint`;
  const dateErrorId = `${dateId}-error`;
  const dialogRef = useRef<HTMLElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);
  const confirmationTitleRef = useRef<HTMLHeadingElement>(null);
  const submittingRef = useRef(false);
  const [step, setStep] = useState<"select" | "confirm">("select");
  const [file, setFile] = useState<File | null>(null);
  const [date, setDate] = useState(today);
  const [errors, setErrors] = useState<DialogErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<ApiError | null>(null);

  const close = useCallback(() => {
    if (submittingRef.current) return;
    setStep("select");
    setFile(null);
    setDate(today);
    setErrors({});
    setSubmitError(null);
    onClose();
  }, [onClose, today]);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const returnTarget = triggerRef.current ?? previousFocus;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
      ).filter((control) => control.getAttribute("aria-hidden") !== "true");
      if (controls.length === 0) {
        event.preventDefault();
        return;
      }
      const first = controls[0]!;
      const last = controls.at(-1)!;
      if (!dialogRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    fileInputRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (returnTarget?.isConnected) returnTarget.focus();
    };
  }, [close, open, triggerRef]);

  useEffect(() => {
    if (open && step === "confirm") confirmationTitleRef.current?.focus();
  }, [open, step]);

  if (!open || typeof document === "undefined") return null;

  const review = () => {
    const nextErrors = { file: fileError(file), date: dateError(date) };
    setErrors(nextErrors);
    if (nextErrors.file) {
      fileInputRef.current?.focus();
      return;
    }
    if (nextErrors.date) {
      dateInputRef.current?.focus();
      return;
    }
    setSubmitError(null);
    setStep("confirm");
  };

  const confirm = async () => {
    if (!file || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onStartUpload(file, date);
      submittingRef.current = false;
      setSubmitting(false);
      close();
    } catch (caught) {
      setSubmitError(
        caught instanceof ApiError
          ? caught
          : new ApiError("Não foi possível reservar a importação."),
      );
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const onBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) close();
  };

  return createPortal(
    <div
      data-testid="import-dialog-backdrop"
      className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-brand-navy/70 p-4 backdrop-blur-sm"
      onMouseDown={onBackdrop}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="relative my-auto w-full max-w-2xl rounded-card border border-line bg-surface p-6 shadow-raised sm:p-8"
      >
        <button
          type="button"
          aria-label="Fechar importação"
          disabled={submitting}
          onClick={close}
          className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-field text-ink-muted hover:bg-canvas focus-visible:outline-2 focus-visible:outline-brand-blue"
        >
          <XIcon size={20} />
        </button>

        {step === "select" ? (
          <div className="flex flex-col gap-6">
            <div className="pr-12">
              <h2 id={titleId} className="text-h2 text-ink">
                Importar dump do ARGUS
              </h2>
              <p
                id={descriptionId}
                className="mt-2 text-body-sm text-ink-muted"
              >
                Formatos aceitos: argus_dump.sql.gz ou arquivo .zip contendo
                exclusivamente argus_dump.sql.gz
              </p>
            </div>

            <div className="rounded-field bg-canvas p-4 text-body-sm text-ink-muted">
              <ul className="grid gap-1 sm:grid-cols-2">
                <li>GZIP: até 5 GiB</li>
                <li>ZIP: até 10 GiB</li>
                <li>GZIP dentro do ZIP: até 5 GiB</li>
                <li>Expansão máxima do ZIP: 100:1</li>
                <li>SQL descompactado: até 100 GiB</li>
              </ul>
              <p className="mt-3">
                O conteúdo e a estrutura do arquivo serão validados com
                segurança no backend antes da ingestão.
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor={fileId}>Arquivo do dump</Label>
              <div className="flex flex-wrap items-center gap-3">
                <span className="relative inline-flex">
                  <Input
                    ref={fileInputRef}
                    id={fileId}
                    type="file"
                    accept=".gz,.zip"
                    aria-label="Selecionar arquivo"
                    className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
                    invalid={Boolean(errors.file)}
                    aria-describedby={errors.file ? fileErrorId : fileHintId}
                    onChange={(event) => {
                      setFile(event.currentTarget.files?.[0] ?? null);
                      setErrors((current) => ({
                        ...current,
                        file: undefined,
                      }));
                    }}
                  />
                  <span
                    aria-hidden="true"
                    className={buttonClasses({
                      variant: "outline",
                      className:
                        "pointer-events-none peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand-blue",
                    })}
                  >
                    Selecionar arquivo
                  </span>
                </span>
                <span
                  className="min-w-0 break-all text-body-sm text-ink-muted"
                  aria-live="polite"
                >
                  {file?.name ?? "Nenhum arquivo selecionado"}
                </span>
              </div>
              {errors.file ? (
                <FieldError id={fileErrorId} role="alert">
                  {errors.file}
                </FieldError>
              ) : (
                <FieldHint id={fileHintId}>
                  A validação usa nome e tamanho; o tipo MIME do navegador não é
                  considerado.
                </FieldHint>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor={dateId}>Data de extração do dump</Label>
              <Input
                ref={dateInputRef}
                id={dateId}
                type="date"
                required
                fieldSize="md"
                value={date}
                invalid={Boolean(errors.date)}
                aria-describedby={errors.date ? dateErrorId : dateHintId}
                onChange={(event) => {
                  setDate(event.currentTarget.value);
                  setErrors((current) => ({ ...current, date: undefined }));
                }}
              />
              {errors.date ? (
                <FieldError id={dateErrorId} role="alert">
                  {errors.date}
                </FieldError>
              ) : (
                <FieldHint id={dateHintId}>
                  Informe a data em que o dump foi extraído na origem, não a
                  data do envio.
                </FieldHint>
              )}
            </div>

            <div className="flex flex-wrap justify-end gap-3">
              <Button variant="outline" onClick={close}>
                Cancelar
              </Button>
              <Button onClick={review}>Revisar importação</Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            <div className="pr-12">
              <h2
                ref={confirmationTitleRef}
                id={titleId}
                tabIndex={-1}
                className="text-h2 text-ink outline-none"
              >
                Confirmar importação
              </h2>
              <p
                id={descriptionId}
                className="mt-2 text-body-sm text-ink-muted"
              >
                Revise os dados antes de reservar a vaga de importação.
              </p>
            </div>

            <dl className="grid gap-4 rounded-field border border-line p-4 sm:grid-cols-3">
              <div>
                <dt className="text-label text-ink-subtle">Arquivo</dt>
                <dd className="mt-1 break-all text-body-sm text-ink">
                  {file?.name}
                </dd>
              </div>
              <div>
                <dt className="text-label text-ink-subtle">Tamanho</dt>
                <dd className="mt-1 text-body-sm text-ink">
                  {formatBytes(file?.size ?? 0)}
                </dd>
              </div>
              <div>
                <dt className="text-label text-ink-subtle">Data de extração</dt>
                <dd className="mt-1 text-body-sm text-ink">
                  {formatCivilDate(date)}
                </dd>
              </div>
            </dl>

            <Alert tone="warning">
              Ao confirmar, esta importação reservará a única vaga global e o
              upload será iniciado. O processamento continuará no backend depois
              que o arquivo for recebido. O dataset ativo não será alterado.
            </Alert>

            {submitError ? (
              <Alert
                tone="critical"
                title="Não foi possível iniciar a importação"
              >
                {submitError.message}
                {submitError.requestId
                  ? ` ID da solicitação: ${submitError.requestId}.`
                  : ""}
              </Alert>
            ) : null}

            <div className="flex flex-wrap justify-end gap-3">
              <Button
                variant="outline"
                disabled={submitting}
                onClick={() => setStep("select")}
              >
                Voltar
              </Button>
              <Button loading={submitting} onClick={() => void confirm()}>
                Confirmar e iniciar upload
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>,
    document.body,
  );
}
