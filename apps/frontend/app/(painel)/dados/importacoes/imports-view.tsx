"use client";

import { useCallback, useRef, useState } from "react";

import { PageHeader } from "@/components/dashboard/page-header";
import { ImportActivationDialog } from "@/components/imports/import-activation-dialog";
import { ImportHistory } from "@/components/imports/import-history";
import { ImportStatusCard } from "@/components/imports/import-status-card";
import { ImportUploadDialog } from "@/components/imports/import-upload-dialog";
import { useImportUpload } from "@/components/imports/import-upload-provider";
import { Alert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import type { ImportSnapshot } from "@/lib/imports/types";

export function ImportsView() {
  const {
    imports,
    activeImport,
    activeDatasetVersion,
    activatingVersion,
    nextCursor,
    transfer,
    uploadProgress,
    needsFileReselection,
    readError,
    transferError,
    conflict,
    loading,
    loadingMore,
    startUpload,
    resumeUpload,
    retryUpload,
    refresh,
    loadMore,
    activate,
  } = useImportUpload();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const activeSectionRef = useRef<HTMLElement>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [activationCandidate, setActivationCandidate] =
    useState<ImportSnapshot | null>(null);
  const openDialog = useCallback(() => setDialogOpen(true), []);
  const closeDialog = useCallback(() => setDialogOpen(false), []);
  const focusActiveImport = useCallback(() => {
    activeSectionRef.current?.focus({ preventScroll: true });
  }, []);
  const visibleConflict =
    activeImport && conflict?.importId === activeImport.importId
      ? conflict
      : null;
  const history = activeImport
    ? imports.filter((item) => item.importId !== activeImport.importId)
    : [...imports];
  const sessionExpired =
    readError?.status === 401 && readError.code === "UNAUTHENTICATED";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Importações"
        subtitle="Envie dumps do ARGUS e acompanhe as importações compartilhadas. A importação cria um candidato e não altera o dataset ativo."
        actions={
          <div className="flex flex-col items-start gap-2 sm:items-end">
            <button
              type="button"
              ref={triggerRef}
              disabled={Boolean(activeImport)}
              onClick={openDialog}
              className={buttonClasses()}
            >
              Importar dump do ARGUS
            </button>
            {activeImport && !visibleConflict ? (
              <p className="text-caption text-ink-muted">
                Já existe uma importação em andamento.{" "}
                <a
                  href="#importacao-atual"
                  onClick={focusActiveImport}
                  className="font-semibold text-ink-brand underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-brand-blue"
                >
                  Ver importação em andamento
                </a>
              </p>
            ) : null}
          </div>
        }
      />

      {visibleConflict ? (
        <Alert tone="warning" title="Outra importação já está em andamento">
          {visibleConflict.error.message}
          {visibleConflict.error.requestId
            ? ` ID da solicitação: ${visibleConflict.error.requestId}.`
            : ""}{" "}
          <a
            href="#importacao-atual"
            onClick={focusActiveImport}
            className="font-semibold underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-warning-strong"
          >
            Ver importação em andamento
          </a>
        </Alert>
      ) : null}

      {readError ? (
        <div className="flex flex-col items-start gap-3">
          <Alert
            tone="critical"
            title="Não foi possível atualizar as importações"
          >
            {readError.message}
            {readError.requestId
              ? ` ID da solicitação: ${readError.requestId}.`
              : ""}
          </Alert>
          <Button
            variant="outline"
            onClick={() => void refresh().catch(() => undefined)}
          >
            Tentar atualizar
          </Button>
        </div>
      ) : null}

      {activeImport ? (
        <section
          ref={activeSectionRef}
          id="importacao-atual"
          tabIndex={-1}
          aria-labelledby="titulo-importacao-atual"
          className="scroll-mt-16 outline-none focus-visible:ring-2 focus-visible:ring-brand-blue"
        >
          <h2 id="titulo-importacao-atual" className="sr-only">
            Importação atual
          </h2>
          <ImportStatusCard
            snapshot={activeImport}
            transfer={transfer}
            uploadProgress={uploadProgress}
            needsFileReselection={needsFileReselection}
            transferError={transferError}
            onResume={resumeUpload}
            onRetry={retryUpload}
          />
        </section>
      ) : null}

      {!sessionExpired ? (
        <ImportHistory
          imports={history}
          loading={loading}
          loadingMore={loadingMore}
          nextCursor={nextCursor}
          onLoadMore={loadMore}
          activeDatasetVersion={activeDatasetVersion}
          activatingVersion={activatingVersion}
          onActivate={setActivationCandidate}
        />
      ) : null}

      <ImportUploadDialog
        open={dialogOpen}
        onClose={closeDialog}
        onStartUpload={startUpload}
        triggerRef={triggerRef}
      />
      <ImportActivationDialog
        candidate={activationCandidate}
        onClose={() => setActivationCandidate(null)}
        onConfirm={activate}
      />
    </div>
  );
}
