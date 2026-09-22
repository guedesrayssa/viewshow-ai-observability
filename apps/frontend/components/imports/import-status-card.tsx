"use client";

import { useEffect, useId, useState } from "react";

import {
  formatBytes,
  formatCivilDate,
  formatLocalInstant,
  importAuthorLabel,
  importFailureMessage,
  importStageLabel,
  importStatePresentation,
  shortDatasetVersion,
} from "@/components/imports/import-presentation";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { FieldError, Input, Label } from "@/components/ui/input";
import { ApiError } from "@/lib/data/client";
import { formatInteger } from "@/lib/format";
import type { ImportSnapshot, UploadProgress } from "@/lib/imports/types";

const LEGACY_STAGES = [
  "RESTORING",
  "VALIDATING",
  "INGESTING",
  "PROJECTING",
  "ARCHIVING",
  "PUBLISHING",
] as const;

const CANONICAL_STAGES = [
  "RESTORING",
  "VALIDATING",
  "EXTRACTING",
  "ARCHIVING",
  "PROJECTING",
  "MATERIALIZING_HOT",
  "FINALIZING_CANDIDATE",
  "PUBLISHING",
] as const;

const HEARTBEAT_STALE_AFTER_MS = 2 * 60 * 1000;

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0
    ? `${hours} h`
    : `${hours} h ${remainingMinutes} min`;
}

export type ImportStatusCardProps = {
  snapshot: ImportSnapshot;
  transfer: "idle" | "starting" | "uploading" | "completing" | "failed";
  uploadProgress: UploadProgress | null;
  needsFileReselection: boolean;
  transferError?: ApiError | null;
  onResume(file: File): Promise<void>;
  onRetry(): Promise<void>;
};

function ImportProgressView({
  snapshot,
  uploadProgress,
}: Pick<ImportStatusCardProps, "snapshot" | "uploadProgress">) {
  const [nowMs, setNowMs] = useState(() => Date.parse(snapshot.updatedAt));
  useEffect(() => {
    const update = () => setNowMs(Date.now());
    update();
    const timer = window.setInterval(update, 30_000);
    return () => window.clearInterval(timer);
  }, [snapshot.updatedAt]);

  if (snapshot.progress.kind === "bytes") {
    const total = snapshot.progress.totalBytes;
    const localVisible =
      snapshot.canManageUpload && uploadProgress
        ? uploadProgress.confirmedBytes + uploadProgress.inFlightBytes
        : 0;
    const visible = Math.min(
      total,
      Math.max(snapshot.progress.completedBytes, localVisible),
    );
    const percent =
      visible === total ? 100 : Math.floor((visible / total) * 100);
    return (
      <div className="flex flex-col gap-2">
        <div
          role="progressbar"
          aria-label="Progresso do upload"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={`${formatBytes(visible)} de ${formatBytes(total)} enviados`}
          className="h-2.5 overflow-hidden rounded-pill bg-canvas"
        >
          <span
            className="block h-full rounded-pill bg-gradient-brand transition-[width] duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
        <p className="text-body-sm text-ink-muted">
          {formatBytes(visible)} de {formatBytes(total)} enviados · {percent}%
        </p>
      </div>
    );
  }

  if (snapshot.progress.kind === "stage") {
    const progress = snapshot.progress;
    const inLegacy = LEGACY_STAGES.includes(
      progress.stage as (typeof LEGACY_STAGES)[number],
    );
    const inCanonical = CANONICAL_STAGES.includes(
      progress.stage as (typeof CANONICAL_STAGES)[number],
    );
    const sharedStage = inLegacy && inCanonical;
    const selectedStages = inCanonical ? CANONICAL_STAGES : LEGACY_STAGES;
    const known = inLegacy || inCanonical;
    const stages: readonly string[] =
      known && !sharedStage ? selectedStages : [progress.stage];
    const currentIndex = stages.indexOf(progress.stage);
    const details =
      progress.stageStartedAt !== undefined &&
      progress.heartbeatAt !== undefined &&
      progress.recordsTotal !== undefined &&
      progress.currentDataset !== undefined &&
      progress.datasetsCompleted !== undefined &&
      progress.datasetsTotal !== undefined
        ? {
            stageStartedAt: progress.stageStartedAt,
            heartbeatAt: progress.heartbeatAt,
            recordsTotal: progress.recordsTotal,
            currentDataset: progress.currentDataset,
            datasetsCompleted: progress.datasetsCompleted,
            datasetsTotal: progress.datasetsTotal,
          }
        : null;
    const heartbeatAge = details
      ? Math.max(0, nowMs - Date.parse(details.heartbeatAt))
      : null;
    const heartbeatIsStale =
      heartbeatAge !== null && heartbeatAge > HEARTBEAT_STALE_AFTER_MS;
    const recordsPercent =
      details && details.recordsTotal !== null && details.recordsTotal > 0
        ? Math.min(
            100,
            Math.floor((progress.recordsRead / details.recordsTotal) * 100),
          )
        : null;
    return (
      <div className="flex flex-col gap-4">
        <ol
          aria-label="Etapas do processamento"
          className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3"
        >
          {stages.map((stage, index) => {
            const state =
              index < currentIndex
                ? "Concluída"
                : index === currentIndex
                  ? "Em andamento"
                  : "Aguardando";
            return (
              <li
                key={stage}
                aria-current={stage === progress.stage ? "step" : undefined}
                className="flex items-center justify-between gap-2 rounded-field border border-line px-3 py-2 text-body-sm text-ink-muted aria-[current=step]:border-brand-blue aria-[current=step]:bg-info-soft aria-[current=step]:font-semibold aria-[current=step]:text-ink"
              >
                <span
                  aria-current={stage === progress.stage ? "step" : undefined}
                >
                  {importStageLabel(
                    stage,
                    stage === progress.stage ? progress.substage : undefined,
                  )}
                </span>
                <span className="text-caption text-ink-subtle">{state}</span>
              </li>
            );
          })}
        </ol>
        {sharedStage ? (
          <p className="text-caption text-ink-subtle">
            Etapa compartilhada pelos fluxos legado e canônico; a ordem completa
            não está disponível.
          </p>
        ) : !known ? (
          <p className="text-caption text-ink-subtle">
            Etapa informada pelo processamento
          </p>
        ) : null}
        {details ? (
          <div className="grid gap-3 rounded-field border border-line bg-canvas p-4 lg:grid-cols-[1fr_auto]">
            <div className="flex flex-col gap-1">
              <p className="text-body-sm font-semibold text-ink">
                {heartbeatIsStale ? "Sem atualização recente" : "Worker ativo"}
              </p>
              <p className="text-caption text-ink-muted">
                Etapa iniciada em {formatLocalInstant(details.stageStartedAt)} ·
                há {formatElapsed(nowMs - Date.parse(details.stageStartedAt))}
              </p>
              <p className="text-caption text-ink-muted">
                Última atividade em {formatLocalInstant(details.heartbeatAt)} ·
                há {formatElapsed(heartbeatAge!)}
              </p>
              {details.currentDataset ? (
                <p className="mt-1 text-body-sm text-ink">
                  Processando <code>{details.currentDataset}</code>
                </p>
              ) : (
                <p className="mt-1 text-body-sm text-ink-muted">
                  {heartbeatIsStale
                    ? "Aguardando um novo sinal do worker."
                    : "Worker ativo, aguardando a operação atual concluir."}
                </p>
              )}
              <p className="text-caption text-ink-muted">
                {details.datasetsCompleted} de {details.datasetsTotal} datasets
                concluídos
              </p>
            </div>
            {heartbeatIsStale ? (
              <Badge tone="warning" withDot>
                Verificando atividade
              </Badge>
            ) : (
              <Badge tone="success" withDot>
                Atividade recente
              </Badge>
            )}
          </div>
        ) : (
          <p className="text-caption text-ink-subtle">
            Aguardando o próximo sinal detalhado do worker.
          </p>
        )}
        {details && recordsPercent !== null && details.recordsTotal !== null ? (
          <div className="flex flex-col gap-2">
            <div
              role="progressbar"
              aria-label="Progresso dos registros"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={recordsPercent}
              aria-valuetext={`${formatInteger(progress.recordsRead)} de ${formatInteger(details.recordsTotal)} registros lidos`}
              className="h-2.5 overflow-hidden rounded-pill bg-canvas"
            >
              <span
                className="block h-full rounded-pill bg-gradient-brand transition-[width] duration-300"
                style={{ width: `${recordsPercent}%` }}
              />
            </div>
            <p className="text-caption text-ink-muted">
              {formatInteger(progress.recordsRead)} de{" "}
              {formatInteger(details.recordsTotal)} registros lidos ·{" "}
              {recordsPercent}%
            </p>
          </div>
        ) : null}
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-field bg-canvas p-3">
            <dt className="text-caption text-ink-subtle">Registros lidos</dt>
            <dd className="mt-1 text-title text-ink">
              {formatInteger(progress.recordsRead)}
            </dd>
          </div>
          <div className="rounded-field bg-canvas p-3">
            <dt className="text-caption text-ink-subtle">Registros gravados</dt>
            <dd className="mt-1 text-title text-ink">
              {formatInteger(progress.recordsWritten)}
            </dd>
          </div>
          <div className="rounded-field bg-canvas p-3">
            <dt className="text-caption text-ink-subtle">
              Registros rejeitados
            </dt>
            <dd className="mt-1 text-title text-ink">
              {formatInteger(progress.recordsRejected)}
            </dd>
          </div>
        </dl>
      </div>
    );
  }
  return null;
}

export function ImportStatusCard({
  snapshot,
  transfer,
  uploadProgress,
  needsFileReselection,
  transferError,
  onResume,
  onRetry,
}: ImportStatusCardProps) {
  const presentation = importStatePresentation(snapshot.state);
  const resumeId = useId();
  const resumeErrorId = `${resumeId}-error`;
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const resume = async (file: File | undefined) => {
    if (!file) return;
    if (file.name !== snapshot.fileName || file.size !== snapshot.sizeBytes) {
      setResumeError(
        "O nome e o tamanho precisam corresponder ao arquivo do envio original.",
      );
      return;
    }
    setResumeError(null);
    setResuming(true);
    try {
      await onResume(file);
    } catch (caught) {
      setResumeError(
        caught instanceof Error
          ? caught.message
          : "Não foi possível retomar o upload.",
      );
    } finally {
      setResuming(false);
    }
  };

  const retry = async () => {
    setRetrying(true);
    try {
      await onRetry();
    } catch {
      // O provider mantém a mensagem segura no contexto para o Alert persistente.
    } finally {
      setRetrying(false);
    }
  };

  return (
    <Card
      padding="lg"
      accent={snapshot.state === "FAILED" ? "critical" : "brand"}
    >
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Importação em andamento</CardTitle>
            <p className="mt-1 break-all text-body-sm text-ink-muted">
              <span>{snapshot.fileName}</span> ·{" "}
              {formatBytes(snapshot.sizeBytes)}
            </p>
          </div>
          <Badge tone={presentation.tone} withDot>
            {presentation.label}
          </Badge>
        </div>

        <p aria-live="polite" className="text-body-sm text-ink-brand">
          {presentation.message}
          {transfer === "completing" ? " Finalizando o envio." : ""}
        </p>

        <dl className="grid gap-4 text-body-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-caption text-ink-subtle">Responsável</dt>
            <dd className="mt-1 text-ink">{importAuthorLabel(snapshot)}</dd>
          </div>
          <div>
            <dt className="text-caption text-ink-subtle">Extração</dt>
            <dd className="mt-1 text-ink">
              {formatCivilDate(snapshot.snapshotExtractedOn)}
            </dd>
          </div>
          <div>
            <dt className="text-caption text-ink-subtle">Iniciada em</dt>
            <dd className="mt-1 text-ink">
              {formatLocalInstant(snapshot.createdAt)}
            </dd>
          </div>
          <div>
            <dt className="text-caption text-ink-subtle">Atualizada em</dt>
            <dd className="mt-1 text-ink">
              {formatLocalInstant(snapshot.updatedAt)}
            </dd>
          </div>
        </dl>

        <ImportProgressView
          snapshot={snapshot}
          uploadProgress={uploadProgress}
        />

        {snapshot.state === "UPLOADED" ? (
          <Alert tone="info">
            Upload concluído. Aguardando o início do processamento.
          </Alert>
        ) : null}

        {snapshot.state === "READY" && snapshot.candidateVersion ? (
          <Alert tone="success">
            Versão {shortDatasetVersion(snapshot.candidateVersion)} pronta para
            ativação. O dataset ativo ainda não foi alterado.
          </Alert>
        ) : null}

        {snapshot.state === "FAILED" ? (
          <Alert tone="critical" title="A importação falhou">
            {snapshot.error ? (
              <>
                {importFailureMessage(snapshot.error.code)} Código:{" "}
                {snapshot.error.code}. ID da solicitação:{" "}
                {snapshot.error.requestId}.
              </>
            ) : (
              "A importação falhou. Atualize a página ou contate o suporte."
            )}
          </Alert>
        ) : null}

        {!snapshot.canManageUpload ? (
          <Alert tone="info">
            Importação iniciada por {importAuthorLabel(snapshot)}. Você pode
            acompanhar o progresso nesta página.
          </Alert>
        ) : null}

        {snapshot.canManageUpload &&
        snapshot.state === "UPLOADING" &&
        needsFileReselection ? (
          <div className="flex flex-col gap-3">
            <Alert tone="warning" title="Selecione novamente o arquivo">
              Selecione novamente o mesmo arquivo para retomar o upload. O nome
              e o tamanho precisam corresponder ao envio original; as partes já
              recebidas serão verificadas antes da retomada.
            </Alert>
            <div className="flex flex-col gap-2">
              <Label htmlFor={resumeId}>Selecionar arquivo para retomar</Label>
              <Input
                id={resumeId}
                type="file"
                accept=".gz,.zip"
                fieldSize="sm"
                disabled={resuming}
                invalid={Boolean(resumeError)}
                aria-describedby={resumeError ? resumeErrorId : undefined}
                onChange={(event) =>
                  void resume(event.currentTarget.files?.[0])
                }
              />
              {resumeError ? (
                <FieldError id={resumeErrorId} role="alert">
                  {resumeError}
                </FieldError>
              ) : null}
            </div>
          </div>
        ) : null}

        {snapshot.canManageUpload &&
        transfer === "failed" &&
        !needsFileReselection ? (
          <div className="flex flex-col items-start gap-3">
            <Alert tone="critical" title="O upload foi interrompido">
              {transferError?.message ?? "Não foi possível continuar o upload."}
              {transferError?.requestId
                ? ` ID da solicitação: ${transferError.requestId}.`
                : ""}
            </Alert>
            <Button loading={retrying} onClick={() => void retry()}>
              Tentar novamente
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
