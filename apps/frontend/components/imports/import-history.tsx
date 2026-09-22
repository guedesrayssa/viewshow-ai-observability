"use client";

import {
  formatCivilDate,
  formatLocalInstant,
  importAuthorLabel,
  importStatePresentation,
  shortDatasetVersion,
} from "@/components/imports/import-presentation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { ImportSnapshot } from "@/lib/imports/types";

export type ImportHistoryProps = {
  imports: ImportSnapshot[];
  loading: boolean;
  loadingMore: boolean;
  nextCursor: string | null;
  onLoadMore(): Promise<void>;
  activeDatasetVersion?: string | null;
  activatingVersion?: string | null;
  onActivate?(item: ImportSnapshot): void;
};

function HistorySkeleton() {
  return (
    <Card
      padding="lg"
      aria-label="Carregando histórico de importações"
      aria-busy="true"
    >
      <Skeleton className="h-6 w-64" />
      <div className="mt-5 flex flex-col gap-3">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-12 w-full" />
        ))}
      </div>
    </Card>
  );
}

export function ImportHistory({
  imports,
  loading,
  loadingMore,
  nextCursor,
  onLoadMore,
  activeDatasetVersion = null,
  activatingVersion = null,
  onActivate,
}: ImportHistoryProps) {
  if (loading) return <HistorySkeleton />;

  return (
    <Card
      padding="none"
      role="region"
      aria-labelledby="titulo-historico-importacoes"
    >
      <div className="border-b border-line px-5 py-4 sm:px-6">
        <CardTitle id="titulo-historico-importacoes">
          Histórico de importações
        </CardTitle>
        <p className="mt-1 text-body-sm text-ink-muted">
          Importações realizadas por todas as pessoas usuárias da plataforma.
        </p>
      </div>

      {imports.length === 0 ? (
        <p className="px-5 py-10 text-center text-body-sm text-ink-muted sm:px-6">
          Nenhuma importação concluída ainda.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1120px] border-collapse text-left text-body-sm">
            <caption className="sr-only">
              Histórico compartilhado de importações do ARGUS
            </caption>
            <thead className="bg-canvas text-caption text-ink-subtle">
              <tr>
                <th scope="col" className="px-5 py-3 font-semibold sm:px-6">
                  Estado
                </th>
                <th scope="col" className="px-4 py-3 font-semibold">
                  Arquivo
                </th>
                <th scope="col" className="px-4 py-3 font-semibold">
                  Extração
                </th>
                <th scope="col" className="px-4 py-3 font-semibold">
                  Responsável
                </th>
                <th scope="col" className="px-4 py-3 font-semibold">
                  Iniciada em
                </th>
                <th scope="col" className="px-4 py-3 font-semibold">
                  Atualização
                </th>
                <th scope="col" className="px-4 py-3 font-semibold">
                  Resultado
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {imports.map((item) => {
                const presentation = importStatePresentation(item.state);
                return (
                  <tr key={item.importId} className="align-top">
                    <td className="px-5 py-4 sm:px-6">
                      <Badge tone={presentation.tone} withDot>
                        {presentation.label}
                      </Badge>
                    </td>
                    <th scope="row" className="px-4 py-4 font-medium text-ink">
                      <span className="block max-w-64 break-all">
                        {item.fileName}
                      </span>
                    </th>
                    <td className="px-4 py-4 text-ink-muted">
                      {formatCivilDate(item.snapshotExtractedOn)}
                    </td>
                    <td className="px-4 py-4 text-ink-muted">
                      {importAuthorLabel(item)}
                    </td>
                    <td className="px-4 py-4 text-ink-muted">
                      {formatLocalInstant(item.createdAt)}
                    </td>
                    <td className="px-4 py-4 text-ink-muted">
                      {formatLocalInstant(item.updatedAt)}
                    </td>
                    <td className="max-w-80 px-4 py-4 text-ink-muted">
                      {item.state === "READY" && item.candidateVersion ? (
                        <span className="flex min-w-44 flex-col items-start gap-2">
                          <span className="font-medium text-ink">
                            Versão {shortDatasetVersion(item.candidateVersion)}
                          </span>
                          {activeDatasetVersion === item.candidateVersion ? (
                            <Badge tone="success" withDot>
                              Dataset ativo
                            </Badge>
                          ) : onActivate ? (
                            <Button
                              variant="outline"
                              size="sm"
                              loading={
                                activatingVersion === item.candidateVersion
                              }
                              onClick={() => onActivate(item)}
                            >
                              Ativar versão {shortDatasetVersion(item.candidateVersion)}
                            </Button>
                          ) : null}
                        </span>
                      ) : item.state === "FAILED" ? (
                        item.error ? (
                          <span className="flex flex-col gap-1">
                            <span>{item.error.message}</span>
                            <span className="text-caption text-ink-subtle">
                              Código: {item.error.code} · ID da solicitação:{" "}
                              {item.error.requestId}
                            </span>
                          </span>
                        ) : (
                          "A importação falhou. Atualize a página ou contate o suporte."
                        )
                      ) : (
                        <span aria-label={presentation.message}>—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {nextCursor ? (
        <div className="flex justify-center border-t border-line px-5 py-4 sm:px-6">
          <Button
            variant="outline"
            loading={loadingMore}
            onClick={() => void onLoadMore().catch(() => undefined)}
          >
            Carregar mais
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
