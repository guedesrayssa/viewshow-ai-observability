/** Rotas públicas versionadas expostas pela API operacional. */
export const ENDPOINTS = {
  health: "/health",
  auth: {
    login: "/auth/login",
    register: "/auth/register",
    recover: "/auth/recover",
    logout: "/auth/logout",
    sso: "/auth/sso",
    session: "/auth/session",
  },
  dashboardOverview: "/api/v1/dashboard/overview",
  incidents: "/api/v1/incidents",
  diagnosis: (incidentId: string) =>
    `/api/v1/incidents/${encodeURIComponent(incidentId)}/diagnosis`,
  events: (incidentId: string) =>
    `/api/v1/incidents/${encodeURIComponent(incidentId)}/events`,
  event: (incidentId: string, eventId: string) =>
    `/api/v1/incidents/${encodeURIComponent(incidentId)}/events/${encodeURIComponent(eventId)}`,
  review: (incidentId: string, hypothesisId: string) =>
    `/api/v1/incidents/${encodeURIComponent(incidentId)}/hypotheses/${encodeURIComponent(hypothesisId)}/review`,
  monitoringOverview: "/api/v1/monitoring/overview",
} as const;

export type ApiWindow = `${number}${"m" | "h"}`;
