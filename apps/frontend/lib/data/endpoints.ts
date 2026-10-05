/** Rotas públicas versionadas expostas pela API operacional. */
export const ENDPOINTS = {
  health: "/health",
  auth: {
    login: "/auth/login",
    callback: "/auth/callback",
    logout: "/auth/logout",
    session: "/auth/session",
  },
  dashboardOverview: "/api/v1/dashboard/overview",
  incidents: "/api/v1/incidents",
  globalEvents: "/api/v1/events",
  globalEvent: (eventId: string) =>
    `/api/v1/events/${encodeURIComponent(eventId)}`,
  diagnosis: (incidentId: string) =>
    `/api/v1/incidents/${encodeURIComponent(incidentId)}/diagnosis`,
  events: (incidentId: string) =>
    `/api/v1/incidents/${encodeURIComponent(incidentId)}/events`,
  event: (incidentId: string, eventId: string) =>
    `/api/v1/incidents/${encodeURIComponent(incidentId)}/events/${encodeURIComponent(eventId)}`,
  reanalyze: (incidentId: string) =>
    `/api/v1/incidents/${encodeURIComponent(incidentId)}/reanalyze`,
  review: (incidentId: string, hypothesisId: string) =>
    `/api/v1/incidents/${encodeURIComponent(incidentId)}/hypotheses/${encodeURIComponent(hypothesisId)}/review`,
  monitoringOverview: "/api/v1/monitoring/overview",
  argusIntegration: "/api/v1/integrations/argus",
  imports: {
    root: "/api/v1/imports",
    status: (importId: string) =>
      `/api/v1/imports/${encodeURIComponent(importId)}`,
    parts: (importId: string) =>
      `/api/v1/imports/${encodeURIComponent(importId)}/parts`,
    restart: (importId: string) =>
      `/api/v1/imports/${encodeURIComponent(importId)}/restart`,
    complete: (importId: string) =>
      `/api/v1/imports/${encodeURIComponent(importId)}/complete`,
    activate: (importId: string) =>
      `/api/v1/imports/${encodeURIComponent(importId)}/activate`,
  },
} as const;

export type ApiWindow = `${number}${"m" | "h"}`;
