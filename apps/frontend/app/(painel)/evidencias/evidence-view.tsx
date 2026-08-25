/**
 * @file evidence-view.tsx
 * Resumo do incidente, hipótese de causa provável, evidências por fonte e
 * linha do tempo de mudanças correlacionadas.
 *
 * Cobre a US-N1-02 (consultar a hipótese e o nível de confiança), a US-N1-03
 * (consultar as evidências, com detalhe expansível por fonte), a US-N1-05
 * (reunir os insumos do direcionamento) e a US-ENG-01 (confirmar ou refutar
 * tecnicamente a hipótese, com autoria e horário do registro). Os dados são
 * um exemplo fixo, com os mesmos casos do protótipo de alta fidelidade,
 * enquanto a integração com a telemetria não existe.
 */

"use client";

import { useState } from "react";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { CheckIcon, XIcon } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { ACCOUNT_PROFILE } from "@/lib/settings-data";

import { BufferingChart } from "@/app/(painel)/evidencias/buffering-chart";

const INCIDENT = {
  id: "INC-4821",
  title: "Falhas de reprodução em TVs LG",
  startedMinutesAgo: 18,
  severity: "Crítico",
  investigationStatus: "Em investigação",
  affectedSessions: "12,4 mil",
};

const HYPOTHESIS = {
  title: "Regressão do decoder no webOS 6.0",
  component: "Player",
  confidence: 78,
  summary:
    "O buffer ratio da Youbora sobe 6,1x minutos após o deploy 4.2.1, concentrado em TVs LG com webOS 6.0. A Tsuru registra o mesmo recorte com 6 minutos de defasagem, e o componente Player concentra os erros do incidente.",
};

type ReviewStatus = "pending" | "confirmed" | "refuted";

const REVIEW_META: Record<Exclude<ReviewStatus, "pending">, { label: string; tone: BadgeTone }> = {
  confirmed: { label: "Confirmada", tone: "success" },
  refuted: { label: "Refutada", tone: "critical" },
};

const CONCENTRATION: { label: string; percentage: number }[] = [
  { label: "webOS 6.0", percentage: 80 },
  { label: "App 4.2.1", percentage: 71 },
  { label: "LG OLED55", percentage: 68 },
  { label: "Nordeste", percentage: 52 },
];

type EvidenceStrength = "forte" | "neutra" | "contra";

const STRENGTH_META: Record<EvidenceStrength, { label: string; tone: BadgeTone }> = {
  forte: { label: "Forte", tone: "critical" },
  neutra: { label: "Neutra", tone: "neutral" },
  contra: { label: "Contra", tone: "success" },
};

type EvidenceSource = {
  id: string;
  source: string;
  summary: string;
  strength: EvidenceStrength;
  detail: string;
};

/** Evidências agrupadas por fonte, com detalhe expansível (US-N1-03). */
const EVIDENCE_SOURCES: EvidenceSource[] = [
  {
    id: "youbora",
    source: "Youbora",
    summary: "falhas +312% · buffer 6,1x",
    strength: "forte",
    detail:
      "Métrica buffer_ratio, recorte LG webOS 6.0 · App 4.2.1. Amostra de 12,4 mil sessões, atualizada há 2 min.",
  },
  {
    id: "tsuru",
    source: "Tsuru",
    summary: "deploy 4.2.1 · diferença de 6 min",
    strength: "forte",
    detail:
      "Marco de deploy 4.2.1 às 09:12, 6 minutos antes do início da subida do buffer ratio na Youbora.",
  },
  {
    id: "apollo",
    source: "Apollo",
    summary: "p99 e erros dentro da linha de base",
    strength: "neutra",
    detail:
      "Latência p99 e taxa de erro do backend seguem estáveis no mesmo recorte. Amostra parcial, com 4 min de atraso na ingestão.",
  },
  {
    id: "rpaas-cdn",
    source: "RPaaS/CDN",
    summary: "sem variação de erro de borda",
    strength: "contra",
    detail:
      "Taxa de erro 4xx/5xx e cache hit ratio da CDN seguem estáveis, sem indício de degradação de borda no recorte afetado.",
  },
];

type TimelineTone = "info" | "warning" | "critical" | "navy";

const TIMELINE_DOT_CLASSES: Record<TimelineTone, string> = {
  info: "bg-brand-blue-light",
  warning: "bg-brand-orange",
  critical: "bg-critical",
  navy: "bg-brand-navy",
};

type TimelineMark = {
  time: string;
  label: string;
  source: string;
  tone: TimelineTone;
};

/** Marcos correlacionados no mesmo recorte, em ordem cronológica. */
const TIMELINE: TimelineMark[] = [
  { time: "09:12", label: "Deploy 4.2.1", source: "Tsuru · Player", tone: "info" },
  { time: "09:18", label: "Buffer sobe", source: "Youbora", tone: "warning" },
  { time: "09:23", label: "Segmento detectado", source: "webOS 6.0 · NE", tone: "critical" },
  { time: "09:30", label: "Decoder +18x", source: "Player", tone: "critical" },
  { time: "09:34", label: "Incidente criado", source: "ServiceNow", tone: "info" },
  { time: "09:41", label: "Hipótese 78%", source: "Player · decoder", tone: "navy" },
];

const CHANGE_LIKELIHOODS: { label: string; cause: string; percentage: number; tone: BadgeTone }[] = [
  { label: "Provável", cause: "regressão do decoder", percentage: 78, tone: "critical" },
  { label: "Possível", cause: "degradação de CDN", percentage: 14, tone: "warning" },
  { label: "Possível", cause: "regressão do app", percentage: 8, tone: "info" },
];

type WindowKey = "90" | "180" | "360";

const WINDOW_LABELS: Record<WindowKey, string> = {
  "90": "Janela 90 min",
  "180": "Janela 3 h",
  "360": "Janela 6 h",
};

export function EvidenceView() {
  const [reviewStatus, setReviewStatus] = useState<ReviewStatus>("pending");
  const [expandedSourceId, setExpandedSourceId] = useState<string | null>(null);
  const [timelineWindow, setTimelineWindow] = useState<WindowKey>("90");

  function toggleSource(id: string) {
    setExpandedSourceId((current) => (current === id ? null : id));
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-caption font-medium tracking-wide text-ink-subtle uppercase">
        Incidente {INCIDENT.id} · Iniciado há {INCIDENT.startedMinutesAgo} min
      </p>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
        <Card accent="critical" padding="lg" className="flex flex-col justify-between gap-8">
          <div>
            <h2 className="text-h2 text-ink">{INCIDENT.title}</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge tone="critical">{INCIDENT.severity}</Badge>
              <Badge tone="info">{INCIDENT.investigationStatus}</Badge>
            </div>
          </div>

          <div>
            <p className="text-display text-ink">{INCIDENT.affectedSessions}</p>
            <p className="mt-1 text-body-sm text-brand-blue underline underline-offset-2">
              sessões afetadas
            </p>
          </div>
        </Card>

        <Card accent="info" padding="lg" className="flex flex-col gap-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <CardTitle>Hipótese</CardTitle>
            {reviewStatus === "pending" ? (
              <Badge tone="success" withDot>
                {HYPOTHESIS.confidence}% de confiança
              </Badge>
            ) : (
              <Badge tone={REVIEW_META[reviewStatus].tone} withDot>
                {REVIEW_META[reviewStatus].label}
              </Badge>
            )}
          </div>

          <div>
            <h3 className="text-h3 text-ink">{HYPOTHESIS.title}</h3>
            <p className="mt-1 text-body-sm text-brand-blue">
              Componente: {HYPOTHESIS.component}
            </p>
          </div>

          <div>
            <p className="text-label font-medium text-ink">Evidências</p>
            <p className="mt-1 text-body-sm text-ink-muted">{HYPOTHESIS.summary}</p>
          </div>

          <div className="mt-auto flex flex-wrap items-center gap-3">
            <Button
              variant="gradient"
              leadingIcon={<CheckIcon size={16} />}
              disabled={reviewStatus !== "pending"}
              onClick={() => setReviewStatus("confirmed")}
            >
              Confirmar
            </Button>
            <Button
              variant="outline"
              leadingIcon={<XIcon size={16} />}
              disabled={reviewStatus !== "pending"}
              onClick={() => setReviewStatus("refuted")}
            >
              Refutar
            </Button>

            {reviewStatus !== "pending" ? (
              <span className="text-caption text-ink-muted">
                {REVIEW_META[reviewStatus].label} por {ACCOUNT_PROFILE.name} · agora
              </span>
            ) : null}
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <BufferingChart />

        <Card accent="brand" accentPosition="top" padding="lg" className="flex-1">
          <CardTitle>Concentração afetada</CardTitle>
          <CardDescription className="mt-1">Sessões com falha por recorte</CardDescription>

          <div className="mt-5 flex flex-col gap-3">
            {CONCENTRATION.map((item) => (
              <div key={item.label}>
                <div className="flex items-center justify-between text-body-sm">
                  <span className="text-ink">{item.label}</span>
                  <span className="font-semibold text-ink">{item.percentage}%</span>
                </div>
                <div className="mt-1.5 h-2 w-full overflow-hidden rounded-pill bg-canvas">
                  <div
                    className="h-full rounded-pill bg-gradient-brand"
                    style={{ width: `${item.percentage}%` }}
                  />
                </div>
              </div>
            ))}
          </div>

          <p className="mt-4 text-caption text-brand-blue">
            Recorte combinado explica 64% das falhas
          </p>
        </Card>

        <Card accent="brand" accentPosition="top" padding="lg" className="flex-1">
          <CardTitle>Evidências por fonte</CardTitle>
          <CardDescription className="mt-1">Relação com a hipótese principal</CardDescription>

          <ul className="mt-3 flex flex-col divide-y divide-line-subtle">
            {EVIDENCE_SOURCES.map((item) => {
              const expanded = expandedSourceId === item.id;
              const meta = STRENGTH_META[item.strength];

              return (
                <li key={item.id}>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => toggleSource(item.id)}
                    className="flex w-full items-start justify-between gap-3 rounded-field py-3 text-left transition-colors hover:bg-canvas focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-blue-light"
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

                  {expanded ? (
                    <p className="pb-3 text-caption text-ink-muted">{item.detail}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Card>
      </div>

      <Card accent="brand" accentPosition="top" padding="lg">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <CardTitle>Linha do tempo e mudanças que podem ter impactado</CardTitle>
            <CardDescription className="mt-1">
              Marcos correlacionados no mesmo recorte · horário de Brasília
            </CardDescription>
          </div>

          <Select
            aria-label="Janela da linha do tempo"
            fieldSize="sm"
            value={timelineWindow}
            onChange={(event) => setTimelineWindow(event.target.value as WindowKey)}
          >
            {(Object.keys(WINDOW_LABELS) as WindowKey[]).map((key) => (
              <option key={key} value={key}>
                {WINDOW_LABELS[key]}
              </option>
            ))}
          </Select>
        </div>

        <div className="mt-8 overflow-x-auto">
          <div className="grid min-w-[46rem] grid-cols-6 gap-2">
            {TIMELINE.map((mark) => (
              <div key={mark.time} className="flex flex-col items-center gap-2 text-center">
                <span className="text-caption font-semibold text-ink">{mark.time}</span>

                <span className="relative flex w-full items-center justify-center py-1">
                  <span aria-hidden="true" className="absolute inset-x-0 top-1/2 h-px bg-line" />
                  <span
                    aria-hidden="true"
                    className={cn(
                      "relative z-10 h-3 w-3 rounded-pill border-2 border-surface shadow-card",
                      TIMELINE_DOT_CLASSES[mark.tone],
                    )}
                  />
                </span>

                <span className="text-body-sm font-medium text-ink">{mark.label}</span>
                <span className="text-caption text-brand-blue">{mark.source}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-6 flex flex-wrap gap-2">
          {CHANGE_LIKELIHOODS.map((item) => (
            <Badge key={item.cause} tone={item.tone}>
              {item.label}: {item.cause} · {item.percentage}%
            </Badge>
          ))}
        </div>
      </Card>
    </div>
  );
}
