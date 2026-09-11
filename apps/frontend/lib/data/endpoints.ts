/**
 * @file endpoints.ts
 * Caminhos publicados pelas duas APIs deste repositório.
 *
 * Ficam reunidos aqui para que a integração de cada tela seja uma linha de
 * configuração, e não uma busca por strings espalhadas pelos componentes. A
 * separação por API não é organizacional: cada grupo tem uma base de URL
 * própria, e pedir um caminho na API errada é um 404 silencioso.
 *
 * - `operacional` — `apps/backend/api` (Node/Express), montada em `/api/v1`.
 * - `telemetria` — `apps/basica/backend` (Flask), montada em `/v1`.
 */

export const ENDPOINTS = {
  /** Node/Express: incidentes, evidências, hipótese e revisão humana. */
  operacional: {
    /** Sonda de saúde do serviço. */
    health: "/health",
    /** Abre a sessão e devolve o cookie assinado. */
    login: "/auth/login",
    /** Lista incidentes do recorte (`window`, `deviceType`, `region`, `appVersion`). */
    incidents: "/api/v1/incidents",
    /** Detalhe de um incidente. */
    incident: (id: string) => `/api/v1/incidents/${encodeURIComponent(id)}`,
    /** Evidências coletadas para o incidente, com a força de cada uma. */
    incidentEvidence: (id: string) =>
      `/api/v1/incidents/${encodeURIComponent(id)}/evidence`,
    /** Hipótese mais recente. Responde 404 quando ainda não houve diagnóstico. */
    incidentHypothesis: (id: string) =>
      `/api/v1/incidents/${encodeURIComponent(id)}/hypothesis`,
    /** Revisão humana da hipótese. Exige sessão. */
    incidentHypothesisReview: (id: string) =>
      `/api/v1/incidents/${encodeURIComponent(id)}/hypothesis/review`,
    /** Resumo agregado dos incidentes da janela. */
    dashboardSummary: "/api/v1/dashboard/summary",
  },

  /** Flask: medição bruta — QoE, erros, segmentações e séries no tempo. */
  telemetria: {
    /** Sessões simultâneas, volume de eventos e taxa de erros do recorte. */
    realtimeOverview: "/v1/analytics/realtime/overview",
    /** Alertas de limiar e surtos ativos ao fim da janela. */
    realtimeAlerts: "/v1/analytics/realtime/alerts",
    /** Tempo de início, travamento e bitrate agregados da janela. */
    qoeMetrics: "/v1/analytics/qoe/metrics",
    /** As mesmas métricas de QoE, por intervalo. */
    qoeTimeseries: "/v1/analytics/qoe/timeseries",
    /** Total de erros, sessões afetadas e sessões sem falha fatal. */
    errorsSummary: "/v1/analytics/errors/summary",
    /** Códigos de erro mais frequentes. */
    errorsTop: "/v1/analytics/errors/top",
    /** Detalhe de um código de erro, com ocorrências por intervalo. */
    errorDetails: (code: string) =>
      `/v1/analytics/errors/${encodeURIComponent(code)}/details`,
    /** Segmentação por modelo, sistema operacional ou versão do app. */
    breakdownDevices: "/v1/analytics/breakdown/devices",
    /** Segmentação por provedor, CDN ou tipo de conexão. */
    breakdownNetwork: "/v1/analytics/breakdown/network",
    /** Módulos internos relacionados às falhas da janela. */
    rcaModules: "/v1/analytics/rca/modules-breakdown",
    /** Saúde dos serviços e das dependências entre eles. */
    rcaTopology: "/v1/analytics/rca/topology-health",
    /** Padrões recorrentes de erro. */
    rcaFingerprints: "/v1/analytics/rca/fingerprints",
    /** Correlações entre surtos de erros. */
    rcaCorrelations: "/v1/analytics/rca/correlations",
  },
} as const;

/**
 * Janela aceita pela API de telemetria.
 *
 * O formato é `<número><s|m|h|d>`. A API operacional aceita o mesmo formato ou
 * um número puro de minutos.
 */
export type ApiWindow = `${number}${"s" | "m" | "h" | "d"}`;

/**
 * Dimensões que cada segmentação aceita.
 *
 * Declaradas aqui porque a tela precisa saber o que **não** pode pedir: não há
 * dimensão geográfica em nenhuma das duas, e enviar `state` devolve 400.
 */
export const BREAKDOWN_DIMENSIONS = {
  devices: ["model", "os", "os_version", "app_version"],
  network: ["isp", "cdn", "connection_type"],
} as const;
