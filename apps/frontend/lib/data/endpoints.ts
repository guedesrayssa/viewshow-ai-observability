/**
 * @file endpoints.ts
 * Caminhos publicados pela API de telemetria.
 *
 * Espelham as rotas do backend deste repositório
 * (`apps/basica/backend/app/controllers/`). Ficam reunidos aqui para que a
 * integração de cada tela seja uma linha de configuração, e não uma busca por
 * strings espalhadas pelos componentes.
 */

export const ENDPOINTS = {
  /** CCU, volume de eventos e taxa de erros do recorte. */
  realtimeOverview: "/v1/analytics/realtime/overview",
  /** Alertas e anomalias ativos. */
  realtimeAlerts: "/v1/analytics/realtime/alerts",
  /** VST, rebuffer rate e bitrate médio. */
  qoeMetrics: "/v1/analytics/qoe/metrics",
  /** Série temporal de qualidade de experiência. */
  qoeTimeseries: "/v1/analytics/qoe/timeseries",
  /** Resumo de erros e sessões sem falha. */
  errorsSummary: "/v1/analytics/errors/summary",
  /** Códigos de erro mais frequentes. */
  errorsTop: "/v1/analytics/errors/top",
  /** Detalhe de um código de erro. */
  errorDetails: (code: string) => `/v1/analytics/errors/${code}/details`,
  /** Segmentação por dispositivo, sistema operacional e versão do app. */
  breakdownDevices: "/v1/analytics/breakdown/devices",
  /** Segmentação por ISP, CDN e tipo de conexão. */
  breakdownNetwork: "/v1/analytics/breakdown/network",
  /** Saúde dos módulos, para a hipótese de causa provável. */
  rcaModules: "/v1/analytics/rca/modules-breakdown",
  /** Saúde da topologia de processamento. */
  rcaTopology: "/v1/analytics/rca/topology-health",
  /** Assinaturas de falha agrupadas. */
  rcaFingerprints: "/v1/analytics/rca/fingerprints",
  /** Correlações entre mudanças e degradações. */
  rcaCorrelations: "/v1/analytics/rca/correlations",
} as const;

/** Janelas aceitas pelos endpoints analíticos. */
export type ApiWindow = "5m" | "15m" | "30m" | "1h" | "6h" | "24h";
