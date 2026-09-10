type PublicRoute = Readonly<{
  method: "get" | "post" | "patch";
  express: string;
  openapi: string;
}>;

export const PUBLIC_ROUTES = {
  health: { method: "get", express: "/health", openapi: "/health" },
  metrics: { method: "get", express: "/metrics", openapi: "/metrics" },
  authSession: {
    method: "get",
    express: "/auth/session",
    openapi: "/auth/session",
  },
  authLogin: { method: "get", express: "/auth/login", openapi: "/auth/login" },
  authCallback: {
    method: "get",
    express: "/auth/callback",
    openapi: "/auth/callback",
  },
  authLogout: {
    method: "post",
    express: "/auth/logout",
    openapi: "/auth/logout",
  },
  importStart: {
    method: "post",
    express: "/api/v1/imports",
    openapi: "/api/v1/imports",
  },
  importComplete: {
    method: "post",
    express: "/api/v1/imports/:importId/complete",
    openapi: "/api/v1/imports/{importId}/complete",
  },
  importStatus: {
    method: "get",
    express: "/api/v1/imports/:importId",
    openapi: "/api/v1/imports/{importId}",
  },
  dashboardOverview: {
    method: "get",
    express: "/api/v1/dashboard/overview",
    openapi: "/api/v1/dashboard/overview",
  },
  incidents: {
    method: "get",
    express: "/api/v1/incidents",
    openapi: "/api/v1/incidents",
  },
  diagnosis: {
    method: "get",
    express: "/api/v1/incidents/:incidentId/diagnosis",
    openapi: "/api/v1/incidents/{incidentId}/diagnosis",
  },
  review: {
    method: "patch",
    express: "/api/v1/incidents/:incidentId/hypotheses/:hypothesisId/review",
    openapi: "/api/v1/incidents/{incidentId}/hypotheses/{hypothesisId}/review",
  },
  events: {
    method: "get",
    express: "/api/v1/incidents/:incidentId/events",
    openapi: "/api/v1/incidents/{incidentId}/events",
  },
  event: {
    method: "get",
    express: "/api/v1/incidents/:incidentId/events/:eventId",
    openapi: "/api/v1/incidents/{incidentId}/events/{eventId}",
  },
  monitoringOverview: {
    method: "get",
    express: "/api/v1/monitoring/overview",
    openapi: "/api/v1/monitoring/overview",
  },
  reanalyze: {
    method: "post",
    express: "/api/v1/incidents/:incidentId/reanalyze",
    openapi: "/api/v1/incidents/{incidentId}/reanalyze",
  },
} as const satisfies Record<string, PublicRoute>;
