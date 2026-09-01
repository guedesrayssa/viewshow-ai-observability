/**
 * @file evidence-view.tsx
 * Resumo do incidente, hipótese de causa provável, evidências por fonte e
 * linha do tempo de mudanças correlacionadas.
 *
 * Cobre a US-N1-02 (consultar a hipótese e o nível de confiança), a US-N1-03
 * (consultar as evidências, com detalhe expansível por fonte), a US-N1-05
 * (reunir os insumos do direcionamento) e a US-ENG-01 (confirmar ou refutar
 * tecnicamente a hipótese, com autoria e horário do registro).
 *
 * A tela é um argumento, e a ordem em que ela se monta é a ordem do argumento:
 * o incidente, a hipótese com o grau de confiança, as evidências que a
 * sustentam e, por fim, a linha do tempo que amarra tudo.
 */

"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { BufferingChart } from "@/app/(painel)/evidencias/buffering-chart";
import {
  STRENGTH_META,
  TIMELINE_DOT_CLASSES,
  WINDOW_LABELS,
  type BufferingPeriodKey,
  type ReviewStatus,
  type WindowKey,
} from "@/app/(painel)/evidencias/evidence-data";
import {
  fetchBuffering,
  fetchEvidence,
  reviewHypothesis,
  runDiagnosis,
} from "@/app/(painel)/evidencias/evidence-resource";
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
import { CheckIcon, XIcon } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { Skeleton, SkeletonText } from "@/components/ui/skeleton";
import { useResource } from "@/hooks/use-resource";
import { cn } from "@/lib/cn";
import { formatCompact } from "@/lib/format";

const REVIEW_META: Record<
  Exclude<ReviewStatus, "pending">,
  { label: string; tone: BadgeTone }
> = {
  confirmed: { label: "Confirmada", tone: "success" },
  refuted: { label: "Refutada", tone: "critical" },
};

export function EvidenceView() {
  const searchParams = useSearchParams();
  const { profile } = useAccount();

  // Sem recorte na URL, a tela pede a escolha em vez de eleger um incidente
  // sozinha: um diagnóstico aberto "por padrão" pareceria o diagnóstico do
  // momento, e não é.
  const incidentId = searchParams.get("incidente");

  const [review, setReview] = useState<{
    status: ReviewStatus;
    /** Quem assinou nesta sessão. Vazio quando a revisão veio da API. */
    by?: string;
    error?: string;
    saving?: boolean;
  }>({ status: "pending" });
  const [diagnosis, setDiagnosis] = useState<{
    running: boolean;
    error?: string;
  }>({ running: false });
  // Guarda o incidente já tentado automaticamente. Sem isso, a releitura que
  // segue o diagnóstico voltaria a disparar o efeito, e um incidente que
  // falhasse entraria em laço de chamadas ao servidor.
  const autoDiagnosedRef = useRef<string | null>(null);
  const [expandedSourceId, setExpandedSourceId] = useState<string | null>(null);
  const [timelineWindow, setTimelineWindow] = useState<WindowKey>("90");
  const [bufferingPeriod, setBufferingPeriod] = useState<BufferingPeriodKey>("120");

  const evidence = useResource(
    (revision) => fetchEvidence(incidentId ?? "", revision),
    [incidentId],
    { enabled: incidentId !== null },
  );

  const buffering = useResource(
    (revision) => fetchBuffering(bufferingPeriod, revision),
    [bufferingPeriod],
    { enabled: incidentId !== null },
  );

  const data = evidence.data;

  function toggleSource(id: string) {
    setExpandedSourceId((current) => (current === id ? null : id));
  }

  /**
   * Dispara o diagnóstico e relê a tela. A hipótese exibida passa a ser a que
   * ficou gravada, não a que voltou nesta resposta.
   */
  async function startDiagnosis() {
    if (!incidentId) return;

    setDiagnosis({ running: true });
    const result = await runDiagnosis(incidentId);

    if (result.ok) {
      setDiagnosis({ running: false });
      evidence.refresh();
    } else {
      setDiagnosis({ running: false, error: result.message });
    }
  }

  // Um incidente sem hipótese não é um erro de leitura, é um diagnóstico que
  // ainda não rodou — e quem abre a tela quer o diagnóstico, não um aviso de
  // que ele falta. Dispara uma vez por incidente; o botão cobre o retry.
  useEffect(() => {
    if (!incidentId) return;
    if (evidence.status !== "ready") return;
    // Só vale para dado vindo da API: no conjunto de exemplo não há o que
    // diagnosticar, e a chamada iria para um servidor que não está lá.
    if (evidence.source !== "api") return;
    if (data?.hypothesis !== null) return;
    if (autoDiagnosedRef.current === incidentId) return;

    autoDiagnosedRef.current = incidentId;
    void startDiagnosis();
    // `startDiagnosis` é recriada a cada render; a guarda por incidente acima
    // é o que impede a repetição, não a lista de dependências.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidentId, evidence.status, evidence.source, data?.hypothesis]);

  async function submitReview(status: "confirmed" | "refuted") {
    if (!incidentId) return;

    setReview({ status: "pending", saving: true });
    const result = await reviewHypothesis(incidentId, status);

    if (result.ok) {
      setReview({ status: result.status, by: profile.name });
    } else {
      setReview({ status: "pending", error: result.message });
    }
  }

  if (!incidentId) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Evidências"
          subtitle="Hipótese de causa provável e evidências do diagnóstico"
        />
        <Unavailable title="Escolha um incidente para investigar" minHeight={280}>
          Esta tela monta o diagnóstico de um incidente específico, e abrir um
          por conta própria apresentaria um caso qualquer como se fosse o da
          sua investigação. Venha pela lista de Incidentes.
        </Unavailable>
        <Link
          href="/incidentes"
          className={cn(buttonClasses({ variant: "gradient" }), "self-center")}
        >
          Ir para Incidentes
        </Link>
      </div>
    );
  }

  // A revisão registrada na API vale como estado inicial; a feita nesta sessão
  // tem prioridade, porque acabou de acontecer diante da pessoa.
  const reviewStatus =
    review.status !== "pending" ? review.status : (data?.reviewStatus ?? "pending");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={
          data
            ? `Incidente ${data.incident.id} · iniciado há ${data.incident.startedMinutesAgo} min`
            : "Carregando incidente"
        }
        title="Evidências"
        subtitle="Hipótese de causa provável e evidências do diagnóstico"
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

      {evidence.status === "error" ? (
        <Alert tone="critical" title="Não foi possível ler as evidências">
          {evidence.error} Tente atualizar em alguns instantes.
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
        <Reveal className="flex">
          <Card
            accent="critical"
            padding="lg"
            className="flex flex-1 flex-col justify-between gap-8"
          >
            {data ? (
              <>
                <div>
                  <h2 className="text-h2 text-ink">{data.incident.title}</h2>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Badge tone="critical">{data.incident.severity}</Badge>
                    <Badge tone="info">{data.incident.investigationStatus}</Badge>
                  </div>
                </div>

                <div>
                  <p className="text-display text-ink">
                    <AnimatedNumber
                      value={data.incident.affectedDevices}
                      format={formatCompact}
                    />
                  </p>
                  <p className="mt-1 text-body-sm text-ink-brand">
                    dispositivos afetados
                  </p>
                </div>
              </>
            ) : (
              <>
                <div>
                  <Skeleton className="h-7 w-64" />
                  <div className="mt-3 flex gap-2">
                    <Skeleton className="h-6 w-20 rounded-pill" />
                    <Skeleton className="h-6 w-28 rounded-pill" />
                  </div>
                </div>
                <Skeleton className="h-12 w-40" />
              </>
            )}
          </Card>
        </Reveal>

        <Reveal delay={90} className="flex">
          <Card accent="info" padding="lg" className="flex flex-1 flex-col gap-5">
            {data && data.hypothesis === null ? (
              <>
                <CardTitle>Hipótese</CardTitle>
                {diagnosis.running ? (
                  <>
                    <p className="text-caption text-ink-muted">
                      Diagnosticando… o orquestrador procura um caso curado com
                      a mesma assinatura e, sem encontrar, aciona o agente.
                    </p>
                    <Skeleton className="h-6 w-72" />
                    <SkeletonText lines={3} />
                  </>
                ) : (
                  <>
                    <Unavailable
                      title="Ainda sem diagnóstico"
                      className="flex-1"
                    >
                      Este incidente ainda não passou pelo diagnóstico
                      automático. Rodá-lo grava uma hipótese com o grau de
                      confiança e a explicação que a sustenta.
                    </Unavailable>
                    <div className="mt-auto flex flex-col gap-2">
                      <Button
                        variant="gradient"
                        className="self-start"
                        onClick={() => void startDiagnosis()}
                      >
                        Diagnosticar agora
                      </Button>
                      {diagnosis.error ? (
                        <p
                          className="text-caption text-critical-strong"
                          role="alert"
                        >
                          {diagnosis.error}
                        </p>
                      ) : null}
                    </div>
                  </>
                )}
              </>
            ) : data && data.hypothesis ? (
              <>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <CardTitle>Hipótese</CardTitle>
                  {reviewStatus === "pending" ? (
                    <Badge tone="success" withDot>
                      {data.hypothesis.confidence}% de confiança
                    </Badge>
                  ) : (
                    <Badge tone={REVIEW_META[reviewStatus].tone} withDot>
                      {REVIEW_META[reviewStatus].label}
                    </Badge>
                  )}
                </div>

                <div>
                  <h3 className="text-h3 text-ink">{data.hypothesis.title}</h3>
                  <p className="mt-1 text-body-sm text-ink-brand">
                    Componente: {data.hypothesis.component}
                  </p>

                  {/* A barra de confiança preenche até o grau lido: o número e
                      a barra dizem a mesma coisa, uma para leitura e outra
                      para comparação rápida entre hipóteses. */}
                  <div className="mt-3 h-1.5 w-full overflow-hidden rounded-pill bg-line-subtle">
                    <div
                      key={data.hypothesis.confidence}
                      className="track-grow h-full rounded-pill bg-success"
                      style={{ width: `${data.hypothesis.confidence}%` }}
                    />
                  </div>
                </div>

                <div>
                  <p className="text-label font-medium text-ink">Evidências</p>
                  <p className="mt-1 text-body-sm text-ink-muted">
                    {data.hypothesis.summary}
                  </p>
                </div>

                <div className="mt-auto flex flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-3">
                    {/* Confirmar promove o caso à golden set no servidor — um
                        efeito que a interface não desfaz. O texto do botão não
                        esconde isso: a frase de apoio abaixo o diz antes do
                        clique. */}
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
                      Confirmar registra a revisão e promove o caso ao conjunto
                      curado, que passa a responder incidentes com a mesma
                      assinatura.
                    </p>
                  ) : null}
                </div>
              </>
            ) : (
              <>
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-6 w-72" />
                <SkeletonText lines={3} />
                <div className="mt-auto flex gap-3">
                  <Skeleton className="h-11 w-32" />
                  <Skeleton className="h-11 w-28" />
                </div>
              </>
            )}
          </Card>
        </Reveal>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Reveal delay={150} className="flex">
          <BufferingChart
            points={buffering.data?.points}
            marker={buffering.data?.marker ?? null}
            period={bufferingPeriod}
            onPeriodChange={setBufferingPeriod}
          />
        </Reveal>

        <Reveal delay={210} className="flex">
          <Card padding="lg" className="flex-1">
            <CardTitle>Concentração afetada</CardTitle>
            <CardDescription className="mt-1">
              Participação nos erros da janela, por modelo
            </CardDescription>

            {data && data.concentration.length === 0 ? (
              <Unavailable
                title="Sem segmentação disponível"
                className="mt-5 flex-1"
              >
                A telemetria não respondeu a segmentação de erros por modelo,
                ou não há erros na janela para repartir.
              </Unavailable>
            ) : null}

            <div className="mt-5 flex flex-col gap-3">
              {data
                ? data.concentration.map((item, index) => (
                    <div key={item.label}>
                      <div className="flex items-center justify-between text-body-sm">
                        <span className="text-ink">{item.label}</span>
                        <span className="font-semibold text-ink">
                          {item.percentage}%
                        </span>
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
                  ))
                : Array.from({ length: 4 }, (_, index) => (
                    <div key={index}>
                      <Skeleton className="h-3.5 w-full" />
                      <Skeleton className="mt-1.5 h-2 w-full" />
                    </div>
                  ))}
            </div>

            {data && data.concentrationNote ? (
              <p className="mt-4 text-caption text-ink-brand">
                {data.concentrationNote}
              </p>
            ) : null}
          </Card>
        </Reveal>

        <Reveal delay={270} className="flex">
          <Card padding="lg" className="flex-1">
            <CardTitle>Evidências por fonte</CardTitle>
            <CardDescription className="mt-1">
              Relação com a hipótese principal
            </CardDescription>

            {data ? (
              <ul className="mt-3 flex flex-col divide-y divide-line-subtle">
                {data.sources.map((item, index) => {
                  const expanded = expandedSourceId === item.id;
                  const meta = STRENGTH_META[item.strength];

                  return (
                    <Reveal as="li" key={item.id} index={index} variant="rise-sm">
                      <button
                        type="button"
                        aria-expanded={expanded}
                        onClick={() => toggleSource(item.id)}
                        className="focus-ring flex w-full items-start justify-between gap-3 rounded-field py-3 text-left transition-colors duration-200 hover:bg-surface-muted"
                      >
                        <span>
                          <span className="block text-body-sm font-semibold text-ink">
                            {item.source}
                          </span>
                          <span className="mt-0.5 block text-caption text-ink-muted">
                            {item.summary}
                          </span>
                        </span>
                        <Badge tone={meta.tone} className="shrink-0">
                          {meta.label}
                        </Badge>
                      </button>

                      {/* O detalhe abre em altura, e não com um corte seco:
                          é o que mantém a lista estável enquanto o texto
                          aparece. */}
                      <div
                        className={cn(
                          "grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
                          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
                        )}
                      >
                        <div className="overflow-hidden">
                          <p className="pb-3 text-caption text-ink-muted">
                            {item.detail}
                          </p>
                        </div>
                      </div>
                    </Reveal>
                  );
                })}
              </ul>
            ) : (
              <div className="mt-4 flex flex-col gap-4">
                {Array.from({ length: 4 }, (_, index) => (
                  <Skeleton key={index} className="h-12 w-full" />
                ))}
              </div>
            )}
          </Card>
        </Reveal>
      </div>

      <Reveal delay={330}>
        <Card padding="lg">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <CardTitle>
                Linha do tempo e mudanças que podem ter impactado
              </CardTitle>
              <CardDescription className="mt-1">
                Marcos correlacionados no mesmo recorte · horário de Brasília
              </CardDescription>
            </div>

            <Select
              aria-label="Janela da linha do tempo"
              value={timelineWindow}
              onValueChange={(value) => setTimelineWindow(value as WindowKey)}
              options={(Object.keys(WINDOW_LABELS) as WindowKey[]).map((key) => ({
                value: key,
                label: WINDOW_LABELS[key],
              }))}
            />
          </div>

          {data && data.timeline.length === 0 ? (
            <Unavailable title="Sem linha do tempo de mudanças" className="mt-6">
              Nenhuma das origens atuais registra deploys ou mudanças
              correlacionadas a este incidente. A linha do tempo volta quando o
              serviço de ingestão publicar esses marcos.
            </Unavailable>
          ) : null}

          {data && data.timeline.length > 0 ? (
            <>
              <div className="mt-8 overflow-x-auto">
                <div className="grid min-w-[46rem] grid-cols-6 gap-2">
                  {data.timeline.map((mark, index) => (
                    <Reveal
                      key={mark.time}
                      index={index}
                      variant="rise-sm"
                      className="flex flex-col items-center gap-2 text-center"
                    >
                      <span className="text-caption font-semibold text-ink">
                        {mark.time}
                      </span>

                      <span className="relative flex w-full items-center justify-center py-1">
                        <span
                          aria-hidden="true"
                          className="absolute inset-x-0 top-1/2 h-px bg-line"
                        />
                        <span
                          aria-hidden="true"
                          className={cn(
                            "relative z-10 h-3 w-3 rounded-pill border-2 border-surface shadow-card",
                            TIMELINE_DOT_CLASSES[mark.tone],
                          )}
                        />
                      </span>

                      <span className="text-body-sm font-medium text-ink">
                        {mark.label}
                      </span>
                      <span className="text-caption text-ink-brand">
                        {mark.source}
                      </span>
                    </Reveal>
                  ))}
                </div>
              </div>

              <div className="mt-6 flex flex-wrap gap-2">
                {data.changes.map((item, index) => (
                  <Reveal key={item.cause} index={index} variant="scale">
                    <Badge tone={item.tone}>
                      {item.label}: {item.cause} · {item.percentage}%
                    </Badge>
                  </Reveal>
                ))}
              </div>
            </>
          ) : (
            <Skeleton className="mt-8 h-28 w-full" />
          )}
        </Card>
      </Reveal>
    </div>
  );
}
