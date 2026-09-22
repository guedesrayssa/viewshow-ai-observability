"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";

import {
  formatCivilDate,
  shortDatasetVersion,
} from "@/components/imports/import-presentation";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { XIcon } from "@/components/ui/icons";
import { ApiError } from "@/lib/data/client";
import type { ImportSnapshot } from "@/lib/imports/types";

const FOCUSABLE =
  'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export type ImportActivationDialogProps = {
  candidate: ImportSnapshot | null;
  onClose(): void;
  onConfirm(importId: string): Promise<void>;
};

export function ImportActivationDialog({
  candidate,
  onClose,
  onConfirm,
}: ImportActivationDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<ApiError | null>(null);

  const close = useCallback(() => {
    if (submittingRef.current) return;
    setSubmitError(null);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!candidate) return;
    const returnTarget = document.activeElement as HTMLElement | null;
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
      );
      if (controls.length === 0) {
        event.preventDefault();
        return;
      }
      const first = controls[0]!;
      const last = controls.at(-1)!;
      if (!dialogRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    dialogRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (returnTarget?.isConnected) returnTarget.focus();
    };
  }, [candidate, close]);

  if (!candidate || typeof document === "undefined") return null;

  const confirm = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onConfirm(candidate.importId);
      submittingRef.current = false;
      setSubmitting(false);
      close();
    } catch (caught) {
      setSubmitError(
        caught instanceof ApiError
          ? caught
          : new ApiError("Não foi possível ativar esta versão."),
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
      className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-brand-navy/70 p-4 backdrop-blur-sm"
      onMouseDown={onBackdrop}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className="relative my-auto w-full max-w-xl rounded-card border border-line bg-surface p-6 shadow-raised outline-none sm:p-8"
      >
        <button
          type="button"
          aria-label="Fechar ativação"
          disabled={submitting}
          onClick={close}
          className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-field text-ink-muted hover:bg-canvas focus-visible:outline-2 focus-visible:outline-brand-blue"
        >
          <XIcon size={20} />
        </button>

        <div className="flex flex-col gap-6">
          <div className="pr-12">
            <h2 id={titleId} className="text-h2 text-ink">
              Ativar dataset
            </h2>
            <p id={descriptionId} className="mt-2 text-body-sm text-ink-muted">
              Confirme a troca do dataset utilizado pela plataforma.
            </p>
          </div>

          <dl className="grid gap-4 rounded-field border border-line p-4 sm:grid-cols-2">
            <div>
              <dt className="text-label text-ink-subtle">Versão</dt>
              <dd className="mt-1 text-body-sm font-medium text-ink">
                {shortDatasetVersion(candidate.candidateVersion ?? "")}
              </dd>
            </div>
            <div>
              <dt className="text-label text-ink-subtle">Data de extração</dt>
              <dd className="mt-1 text-body-sm text-ink">
                {formatCivilDate(candidate.snapshotExtractedOn)}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-label text-ink-subtle">Arquivo</dt>
              <dd className="mt-1 break-all text-body-sm text-ink">
                {candidate.fileName}
              </dd>
            </div>
          </dl>

          <Alert tone="warning" title="Esta alteração é global">
            Ao confirmar, esta versão passará a alimentar todos os painéis da
            plataforma até que outra versão seja ativada.
          </Alert>

          {submitError ? (
            <Alert tone="critical" title="Não foi possível ativar o dataset">
              {submitError.message}
              {submitError.requestId
                ? ` ID da solicitação: ${submitError.requestId}.`
                : ""}
            </Alert>
          ) : null}

          <div className="flex flex-wrap justify-end gap-3">
            <Button variant="outline" disabled={submitting} onClick={close}>
              Cancelar
            </Button>
            <Button loading={submitting} onClick={() => void confirm()}>
              Confirmar ativação
            </Button>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
