/**
 * @file evidence-view.tsx
 * Aba Diagnóstico do detalhe de um incidente: resumo do impacto, hipótese de
 * causa provável, séries do recorte e evidências por fonte. A linha do tempo
 * tem aba própria.
 *
 * Cobre a US-N1-02 (consultar a hipótese e o nível de confiança), a US-N1-03
 * (consultar as evidências, com detalhe expansível por fonte), a US-N1-05
 * (reunir os insumos do direcionamento) e a US-ENG-01 (confirmar ou refutar
 * tecnicamente a hipótese, com autoria e horário do registro).
 *
 * A tela é um argumento, e a ordem em que ela se monta é a ordem do argumento:
 * o incidente, a hipótese com o grau de confiança e as evidências que a
 * sustentam. Filtros e página das evidências ficam na URL, para que o recorte
 * sobreviva a um recarregamento e possa ser compartilhado.
 */

"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import { BufferingChart } from "@/app/(painel)/incidentes/detalhe/buffering-chart";
import {
  DIAGNOSIS_STATUS_LABELS,
  RELATION_META,
  STRENGTH_LABELS,
  type EvidenceData,
  type EvidenceRelation,
  type EvidenceStrength,
  type ReviewStatus,
} from "@/app/(painel)/incidentes/detalhe/evidence-data";
import {
  fetchEvidence,
  requestReanalysis,
  reviewHypothesis,
} from "@/app/(painel)/incidentes/detalhe/evidence-resource";
import { IncidentDetailHeader } from "@/app/(painel)/incidentes/detalhe/incident-detail-header";
import { useAccount } from "@/components/account/account-provider";
import { DataStatus } from "@/components/dashboard/data-status";
import { PageHeader } from "@/components/dashboard/page-header";
import { Unavailable } from "@/components/dashboard/unavailable";
import { AnimatedNumber } from "@/components/motion/animated-number";
import { Reveal } from "@/components/motion/reveal";
import { Alert } from "@/components/ui/alert";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { CheckIcon, ChevronDownIcon, RefreshIcon, XIcon } from "@/components/ui/icons";
import {
  isPageSize,
  PAGE_SIZE_OPTIONS,
  Pagination,
  usePagedItems,
  type PageSize,
} from "@/components/ui/pagination";
import { SegmentedFilter } from "@/components/ui/segmented-filter";
import { Skeleton, SkeletonText } from "@/components/ui/skeleton";
import { useQueryParams } from "@/hooks/use-query-params";
import { useResource } from "@/hooks/use-resource";
import { cn } from "@/lib/cn";
import { resourceFailed, resourceFailureMessage } from "@/lib/data/resource-state";
import { formatCompact, formatInteger } from "@/lib/format";
import { incidentEventsHref, ROUTES } from "@/lib/routes";

const REVIEW_META: Record<
  Exclude<ReviewStatus, "pending">,
  { label: string; tone: BadgeTone }
> = {
  confirmed: { label: "Confirmada", tone: "success" },
  refuted: { label: "Refutada", tone: "critical" },
};

export function EvidenceView() {
  const searchParams = useSearchParams();
  // Sem recorte na URL, a tela pede a escolha em vez de eleger um incidente
  // sozinha: um diagnóstico aberto "por padrão" pareceria o diagnóstico do
  // momento, e não é.
  const incidentId = searchParams.get("incidente");

  if (!incidentId) return <NoIncidentSelected />;

  // A chave reinicia o estado da tela (revisão feita, fonte aberta, página)
  // quando a URL passa a apontar para outro incidente.
  return <IncidentDiagnosis key={incidentId} incidentId={incidentId} />;
}

function NoIncidentSelected() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Diagnóstico do incidente"
        subtitle="Hipótese de causa provável e evidências do diagnóstico"
      />
      <Unavailable title="Escolha um incidente para investigar" minHeight={280}>
        O diagnóstico é sempre de um incidente específico. Abra um incidente na
        lista para ver a hipótese, as evidências e os eventos correlacionados.
      </Unavailable>
      <Link
        href={ROUTES.incidents}
        className={cn(buttonClasses({ variant: "gradient" }), "self-center")}
      >
        Ir para Incidentes
      </Link>
    </div>
  );
}

function IncidentDiagnosis({ incidentId }: { incidentId: string }) {
  const { profile } = useAccount();

  const [review, setReview] = useState<{
    status: ReviewStatus;
    /** Quem assinou nesta sessão. Vazio quando a revisão veio da API. */
    by?: string;
    error?: string;
    saving?: boolean;
  }>({ status: "pending" });

  const evidence = useResource(() => fetchEvidence(incidentId), [incidentId]);
  const data = evidence.data;
  const failed = resourceFailed(evidence);
  const failure = resourceFailureMessage(
    evidence,
    "O diagnóstico deste incidente não respondeu.",
  );

  async function submitReview(status: "confirmed" | "refuted") {
    setReview({ status: "pending", saving: true });
    const result = await reviewHypothesis(incidentId, status);

    if (result.ok) {
      setReview({ status: result.status, by: profile.name });
    } else {
      setReview({ status: "pending", error: result.message });
    }
  }

  // A revisão registrada na API vale como estado inicial; a feita nesta sessão
  // tem prioridade, porque acabou de acontecer diante da pessoa.
  const reviewStatus =
    review.status !== "pending"
      ? review.status
      : (data?.reviewStatus ?? "pending");

  return (
    <div className="flex flex-col gap-6">
      <IncidentDetailHeader
        incidentId={incidentId}
        section="diagnosis"
        incident={data?.incident}
        actions={<ReanalyzeButton incidentId={incidentId} />}
        status={
          <DataStatus
            showSource={false}
            source={evidence.source}
            availability={evidence.availability}
            warnings={evidence.warnings}
            fetchedAt={evidence.fetchedAt}
            refreshing={evidence.refreshing}
            error={evidence.error}
            onRefresh={evidence.refresh}
          />
        }
      />

      {failed ? (
        <>
          <Alert tone="critical" title="Não foi possível ler o diagnóstico">
            {failure} Tente atualizar em alguns instantes.
          </Alert>
          <Unavailable title="Diagnóstico indisponível" minHeight={220}>
            Sem a leitura do diagnóstico, nenhuma hipótese ou evidência é
            exibida para não afirmar um estado que não foi medido. Os eventos
            correlacionados continuam na aba ao lado.
          </Unavailable>
        </>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
            <Reveal className="flex">
              <ImpactCard data={data} />
            </Reveal>

            <Reveal delay={90} className="flex">
              <Card accent="info" padding="lg" className="flex flex-1 flex-col gap-5">
                {!data ? (
                  <>
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-6 w-72" />
                    <SkeletonText lines={3} />
                    <div className="mt-auto flex gap-3">
                      <Skeleton className="h-11 w-32" />
                      <Skeleton className="h-11 w-28" />
                    </div>
                  </>
                ) : data.hypothesis === null ? (
                  <>
                    <CardTitle>Hipótese</CardTitle>
                    <Unavailable title="Ainda sem hipótese" className="flex-1">
                      {DIAGNOSIS_STATUS_LABELS[data.diagnosisStatus] ?? "Sem diagnóstico"}
                      . Quando o diagnóstico automático rodar, a hipótese aparece
                      aqui com o grau de confiança e as evidências que a
                      sustentam.
                    </Unavailable>
                  </>
                ) : (
                  <>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <CardTitle>Hipótese</CardTitle>
                      {reviewStatus !== "pending" ? (
                        <Badge tone={REVIEW_META[reviewStatus].tone} withDot>
                          {REVIEW_META[reviewStatus].label}
                        </Badge>
                      ) : data.hypothesis.confidence === null ? (
                        <Badge tone="neutral" withDot>
                          Confiança não medida
                        </Badge>
                      ) : (
                        <Badge tone="success" withDot>
                          {data.hypothesis.confidence}% de confiança
                        </Badge>
                      )}
                    </div>

                    <div>
                      <h3 className="text-h3 text-ink">{data.hypothesis.title}</h3>
                      <p className="mt-1 text-body-sm text-ink-brand">
                        Componente: {data.hypothesis.component}
                      </p>

                      {/* A barra de confiança preenche até o grau lido: o
                          número e a barra dizem a mesma coisa. Sem grau
                          medido, a barra não aparece. */}
                      {data.hypothesis.confidence !== null ? (
                        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-pill bg-line-subtle">
                          <div
                            key={data.hypothesis.confidence}
                            className="track-grow h-full rounded-pill bg-success"
                            style={{ width: `${data.hypothesis.confidence}%` }}
                          />
                        </div>
                      ) : null}
                    </div>

                    {data.hypothesis.summary ? (
                      <div>
                        <p className="text-label font-medium text-ink">Justificativa</p>
                        <p className="mt-1 text-body-sm text-ink-muted">
                          {data.hypothesis.summary}
                        </p>
                      </div>
                    ) : null}

                    <div className="mt-auto flex flex-col gap-2">
                      <div className="flex flex-wrap items-center gap-3">
                        {/* Confirmar promove o caso à golden set no servidor —
                            um efeito que a interface não desfaz. A frase de
                            apoio abaixo o diz antes do clique. */}
                        <Button
                          variant="gradient"
                          leadingIcon={<CheckIcon size={16} />}
                          disabled={reviewStatus !== "pending" || review.saving}
                          loading={review.saving}
                          onClick={() => submitReview("confirmed")}
                        >
                          Confirmar
                        </Button>
                        <Button
                          variant="outline"
                          leadingIcon={<XIcon size={16} />}
                          disabled={reviewStatus !== "pending" || review.saving}
                          onClick={() => submitReview("refuted")}
                        >
                          Refutar
                        </Button>

                        {reviewStatus !== "pending" ? (
                          <span className="animate-fade-in text-caption text-ink-muted">
                            {REVIEW_META[reviewStatus].label}
                            {review.by ? ` por ${review.by} · agora` : " anteriormente"}
                          </span>
                        ) : null}
                      </div>

                      {review.error ? (
                        <p className="text-caption text-critical-strong" role="alert">
                          {review.error}
                        </p>
                      ) : reviewStatus === "pending" ? (
                        <p className="text-caption text-ink-subtle">
                          Confirmar registra a revisão e promove o caso ao
                          conjunto curado, que passa a responder incidentes com a
                          mesma assinatura.
                        </p>
                      ) : null}
                    </div>
                  </>
                )}
              </Card>
            </Reveal>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Reveal delay={150} className="flex">
              <BufferingChart
                points={data?.buffering?.points}
                status={data ? "ready" : "loading"}
                marker={data?.buffering?.marker ?? null}
              />
            </Reveal>

            <Reveal delay={210} className="flex">
              <ConcentrationCard data={data} />
            </Reveal>
          </div>

          <Reveal delay={270}>
            <EvidenceList incidentId={incidentId} data={data} />
          </Reveal>

        </>
      )}
    </div>
  );
}

/**
 * Pede uma nova análise automática. O resultado não chega na hora: a API
 * aceita o pedido e o diagnóstico novo aparece numa próxima leitura.
 */
function ReanalyzeButton({ incidentId }: { incidentId: string }) {
  const [state, setState] = useState<{
    saving: boolean;
    message?: string;
    tone?: "ok" | "error";
  }>({ saving: false });

  async function reanalyze() {
    setState({ saving: true });
    const result = await requestReanalysis(incidentId);
    setState(
      result.ok
        ? {
            saving: false,
            tone: "ok",
            message: "Reanálise pedida. Atualize em alguns minutos para ver o novo diagnóstico.",
          }
        : { saving: false, tone: "error", message: result.message },
    );
  }

  return (
    <div className="flex max-w-xs flex-col items-end gap-1.5">
      <Button
        variant="outline"
        leadingIcon={<RefreshIcon size={16} />}
        loading={state.saving}
        disabled={state.saving || state.tone === "ok"}
        onClick={reanalyze}
        title="Pede ao diagnóstico automático uma nova análise deste incidente"
      >
        Reanalisar
      </Button>
      {state.message ? (
        <p
          role={state.tone === "error" ? "alert" : "status"}
          className={cn(
            "text-right text-caption",
            state.tone === "error" ? "text-critical-strong" : "text-ink-muted",
          )}
        >
          {state.message}
        </p>
      ) : null}
    </div>
  );
}

function ImpactCard({ data }: { data?: EvidenceData }) {
  return (
    <Card
      accent="critical"
      padding="lg"
      className="flex flex-1 flex-col justify-between gap-8"
    >
      {data ? (
        <>
          <div>
            <CardTitle>Impacto</CardTitle>
            <CardDescription className="mt-1">
              {DIAGNOSIS_STATUS_LABELS[data.diagnosisStatus] ?? data.diagnosisStatus}
              {data.incident.component ? ` · componente ${data.incident.component}` : ""}
            </CardDescription>
          </div>

          <div>
            <p className="text-display text-ink">
              {data.incident.affectedDevices === null ? (
                "Não medido"
              ) : (
                <AnimatedNumber
                  value={data.incident.affectedDevices}
                  format={formatCompact}
                />
              )}
            </p>
            <p className="mt-1 text-body-sm text-ink-brand">dispositivos afetados</p>
          </div>
        </>
      ) : (
        <>
          <div>
            <Skeleton className="h-5 w-32" />
            <Skeleton className="mt-2 h-4 w-48" />
          </div>
          <Skeleton className="h-12 w-40" />
        </>
      )}
    </Card>
  );
}

function ConcentrationCard({ data }: { data?: EvidenceData }) {
  return (
    <Card padding="lg" className="flex flex-1 flex-col">
      <CardTitle>Concentração afetada</CardTitle>
      <CardDescription className="mt-1">
        Participação nos erros da janela, por modelo
      </CardDescription>

      {!data ? (
        <div className="mt-5 flex flex-col gap-3">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index}>
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="mt-1.5 h-2 w-full" />
            </div>
          ))}
        </div>
      ) : data.concentration.length === 0 ? (
        <Unavailable title="Sem segmentação disponível" className="mt-5 flex-1">
          A telemetria não respondeu a segmentação de erros por modelo, ou não há
          erros na janela para repartir.
        </Unavailable>
      ) : (
        <div className="mt-5 flex flex-col gap-3">
          {data.concentration.map((item, index) => (
            <div key={`${item.label}-${index}`}>
              <div className="flex items-center justify-between text-body-sm">
                <span className="text-ink">{item.label}</span>
                <span className="font-semibold text-ink">{item.percentage}%</span>
              </div>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-pill bg-line-subtle">
                <div
                  key={item.percentage}
                  className="track-grow h-full rounded-pill bg-critical"
                  style={{
                    width: `${item.percentage}%`,
                    animationDelay: `${index * 90}ms`,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {data?.concentrationNote ? (
        <p className="mt-4 text-caption text-ink-brand">{data.concentrationNote}</p>
      ) : null}
    </Card>
  );
}

const RELATION_ORDER: EvidenceRelation[] = ["supports", "contradicts", "context"];
const STRENGTH_ORDER: EvidenceStrength[] = ["strong", "moderate", "weak"];

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Cor de cada relação: o filete da linha, o rótulo e o medidor de força. */
const RELATION_STYLE: Record<
  EvidenceRelation,
  { rail: string; text: string; bar: string }
> = {
  supports: { rail: "bg-critical", text: "text-critical-strong", bar: "bg-critical" },
  contradicts: { rail: "bg-success", text: "text-success-strong", bar: "bg-success" },
  context: { rail: "bg-gray-400", text: "text-ink-muted", bar: "bg-gray-400" },
};

const STRENGTH_LEVEL: Record<EvidenceStrength, number> = {
  weak: 1,
  moderate: 2,
  strong: 3,
};

/**
 * Força como forma: três barras crescentes, preenchidas até o nível, na cor
 * da relação. Lida de relance numa coluna, sem precisar ler a palavra.
 */
function StrengthMeter({
  strength,
  relation,
}: {
  strength: EvidenceStrength;
  relation: EvidenceRelation;
}) {
  const level = STRENGTH_LEVEL[strength];

  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden="true" className="flex h-3.5 items-end gap-[3px]">
        {[1, 2, 3].map((bar) => (
          <span
            key={bar}
            className={cn(
              "w-[5px] rounded-[1.5px]",
              bar === 1 ? "h-[6px]" : bar === 2 ? "h-[10px]" : "h-[14px]",
              bar <= level ? RELATION_STYLE[relation].bar : "bg-line-strong",
            )}
          />
        ))}
      </span>
      <span className="text-caption text-ink">{capitalize(STRENGTH_LABELS[strength])}</span>
    </span>
  );
}

/** Colunas da lista: filete, evidência, relação, força e o indicador de abrir. */
const EVIDENCE_GRID =
  "grid grid-cols-[3px_minmax(0,1fr)_1rem] gap-x-4 sm:grid-cols-[3px_minmax(0,1fr)_7rem_7.5rem_1rem]";

function EvidenceList({
  incidentId,
  data,
}: {
  incidentId: string;
  data?: EvidenceData;
}) {
  const { searchParams, read, update } = useQueryParams();
  const relation = read<EvidenceRelation | "all">("relacao", "all", [
    "all",
    ...RELATION_ORDER,
  ]);
  const strength = read<EvidenceStrength | "all">("forca", "all", [
    "all",
    ...STRENGTH_ORDER,
  ]);
  const requestedPage = Math.max(1, Number(searchParams.get("pagina")) || 1);
  const sizeParam = Number(searchParams.get("itens"));
  const pageSize: PageSize = isPageSize(sizeParam) ? sizeParam : PAGE_SIZE_OPTIONS[0];
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const sources = useMemo(() => data?.sources ?? [], [data]);
  const counts = useMemo(() => {
    const byRelation: Record<EvidenceRelation, number> = {
      supports: 0,
      contradicts: 0,
      context: 0,
    };
    const byStrength: Record<EvidenceStrength, number> = {
      strong: 0,
      moderate: 0,
      weak: 0,
    };
    // A contagem por relação respeita a força escolhida, e vice-versa: o
    // número no botão é o que aparece ao clicar nele.
    for (const item of sources) {
      if (strength === "all" || item.strength === strength) byRelation[item.relation] += 1;
      if (relation === "all" || item.relation === relation) byStrength[item.strength] += 1;
    }
    return { byRelation, byStrength };
  }, [sources, relation, strength]);

  const filtered = useMemo(
    () =>
      sources.filter(
        (item) =>
          (relation === "all" || item.relation === relation) &&
          (strength === "all" || item.strength === strength),
      ),
    [sources, relation, strength],
  );
  const { page, pageCount, pageItems } = usePagedItems(
    filtered,
    requestedPage,
    pageSize,
  );

  function setFilter(patch: Record<string, string | null>) {
    // Todo filtro novo volta para a primeira página.
    update({ ...patch, pagina: null });
  }

  return (
    <Card padding="lg">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <CardTitle>Evidências por fonte</CardTitle>
        {data && sources.length > 0 ? (
          <span className="text-caption tabular-nums text-ink-muted">
            {filtered.length === sources.length
              ? `${formatInteger(sources.length)} evidências`
              : `${formatInteger(filtered.length)} de ${formatInteger(sources.length)} evidências`}
          </span>
        ) : null}
      </div>
      <CardDescription className="mt-1">
        Como cada evento correlacionado se relaciona com a hipótese principal
      </CardDescription>

      {data && sources.length > 0 ? (
        <div className="mt-5 flex flex-col gap-2.5">
            <SegmentedFilter
              label="Relação"
              groupLabel="Filtrar evidências por relação"
              value={relation}
              options={[
                { key: "all", label: "Todas", total: sources.length },
                ...RELATION_ORDER.map((key) => ({
                  key,
                  label: RELATION_META[key].filterLabel,
                  total: counts.byRelation[key],
                })),
              ]}
              onChange={(key) => setFilter({ relacao: key === "all" ? null : key })}
            />
            <SegmentedFilter
              label="Força"
              groupLabel="Filtrar evidências por força"
              value={strength}
              options={[
                { key: "all", label: "Todas", total: null },
                ...STRENGTH_ORDER.map((key) => ({
                  key,
                  label: capitalize(STRENGTH_LABELS[key]),
                  total: counts.byStrength[key],
                })),
              ]}
              onChange={(key) => setFilter({ forca: key === "all" ? null : key })}
            />
        </div>
      ) : null}

      {!data ? (
        <div className="mt-4 flex flex-col gap-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-12 w-full" />
          ))}
        </div>
      ) : sources.length === 0 ? (
        <Unavailable title="Nenhuma evidência correlacionada" className="mt-5">
          Nenhum evento foi correlacionado a este incidente até agora. A aba
          Eventos correlacionados mostra o que chegar da origem.
        </Unavailable>
      ) : filtered.length === 0 ? (
        <div className="mt-5 flex flex-col items-center gap-3">
          <Unavailable title="Nenhuma evidência neste recorte" className="w-full">
            Nenhuma das {formatInteger(sources.length)} evidências combina a
            relação e a força escolhidas.
          </Unavailable>
          <Button
            variant="quiet"
            size="sm"
            onClick={() => setFilter({ relacao: null, forca: null })}
          >
            <XIcon size={16} />
            Limpar filtros
          </Button>
        </div>
      ) : (
        <>
          <div
            aria-hidden="true"
            className={cn(
              EVIDENCE_GRID,
              "mt-6 hidden border-b border-line px-3 pb-2 text-caption text-ink-subtle sm:grid",
            )}
          >
            <span />
            <span>Evidência</span>
            <span>Relação</span>
            <span>Força</span>
            <span />
          </div>
          <ul className="mt-2 flex flex-col divide-y divide-line-subtle sm:mt-0">
            {pageItems.map((item) => {
              const expanded = expandedId === item.id;
              const meta = RELATION_META[item.relation];
              const style = RELATION_STYLE[item.relation];
              const detailId = `evidencia-detalhe-${item.id}`;

              return (
                <li key={item.id}>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={detailId}
                    onClick={() =>
                      setExpandedId((current) => (current === item.id ? null : item.id))
                    }
                    className={cn(
                      EVIDENCE_GRID,
                      "focus-ring w-full items-center rounded-field px-3 py-3.5 text-left transition-colors duration-150",
                      expanded ? "bg-surface-muted" : "hover:bg-surface-muted",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn("h-full min-h-10 self-stretch rounded-pill", style.rail)}
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-body-sm font-medium text-ink">
                        {item.summary}
                      </span>
                      <span className="mt-0.5 block truncate text-caption text-ink-muted">
                        {item.source}
                        <span className="text-ink-subtle">, {item.dataset}</span>
                      </span>
                      {/* No celular, relação e força descem para baixo do resumo. */}
                      <span className="mt-2 flex items-center gap-4 sm:hidden">
                        <span className={cn("text-caption font-semibold", style.text)}>
                          {meta.label}
                        </span>
                        <StrengthMeter strength={item.strength} relation={item.relation} />
                      </span>
                    </span>
                    <span className={cn("hidden text-caption font-semibold sm:block", style.text)}>
                      {meta.label}
                    </span>
                    <span className="hidden sm:block">
                      <StrengthMeter strength={item.strength} relation={item.relation} />
                    </span>
                    <ChevronDownIcon
                      size={16}
                      aria-hidden="true"
                      className={cn(
                        "justify-self-end text-ink-subtle transition-transform duration-200",
                        expanded && "rotate-180",
                      )}
                    />
                  </button>

                  <div
                    id={detailId}
                    className={cn(
                      "grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
                      expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
                    )}
                  >
                    <div className="overflow-hidden pl-[calc(0.75rem+3px+1rem)] pr-3">
                      <dl className="grid gap-x-8 gap-y-2 pb-2 pt-3 text-caption sm:grid-cols-2">
                        {item.fields.map((field) => (
                          <div key={field.label} className="grid min-w-0 grid-cols-[9.5rem_minmax(0,1fr)] gap-3">
                            <dt className="text-ink-subtle">{field.label}</dt>
                            <dd className="min-w-0 break-words font-medium text-ink">
                              {field.value}
                            </dd>
                          </div>
                        ))}
                      </dl>
                      <Link
                        href={incidentEventsHref(incidentId, item.eventId)}
                        className="focus-ring mb-3 mt-1 inline-flex rounded-field text-caption font-semibold text-ink-brand hover:underline"
                      >
                        Abrir evento na aba Eventos
                      </Link>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          <Pagination
            itemLabel="evidências"
            page={page}
            pageCount={pageCount}
            pageSize={pageSize}
            total={filtered.length}
            onPageChange={(next) => update({ pagina: next > 1 ? String(next) : null })}
            onPageSizeChange={(size) =>
              update({
                itens: size === PAGE_SIZE_OPTIONS[0] ? null : String(size),
                pagina: null,
              })
            }
          />
        </>
      )}
    </Card>
  );
}
