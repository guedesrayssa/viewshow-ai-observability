import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const meta = {
  requestId: "req_frontend",
  schemaVersion: "1.0",
  datasetVersion: null,
  generatedAt: "2026-01-01T00:00:00Z",
  window: null,
  partial: true,
  refreshAfterSeconds: 30,
  freshness: [],
  warnings: [{ code: "PARTIAL", message: "controlled" }],
};

describe("gateway client", () => {
  it("authenticates through the backend without exposing Cognito configuration", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://operacional.test");
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (input: string | URL | Request, init?: RequestInit) => {
          requests.push({ url: String(input), init });
          return new Response(
            JSON.stringify({
              data: { user: { email: "ana@globo.com" } },
              meta,
            }),
            { status: 200 },
          );
        },
      ),
    );
    const { authenticateWithPassword } = await import("@/lib/auth");

    await expect(
      authenticateWithPassword(" ana@globo.com ", "Senha123"),
    ).resolves.toEqual({ kind: "authenticated" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://operacional.test/auth/login");
    expect(requests[0]?.init).toMatchObject({
      method: "POST",
      credentials: "include",
      cache: "no-store",
      body: JSON.stringify({
        username: "ana@globo.com",
        password: "Senha123",
      }),
    });
  });

  it("returns a simple message for invalid credentials", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://operacional.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: "UNAUTHENTICATED" } }),
            { status: 401 },
          ),
      ),
    );
    const { authenticateWithPassword } = await import("@/lib/auth");

    await expect(
      authenticateWithPassword("ana@globo.com", "errada"),
    ).resolves.toEqual({
      kind: "error",
      message: "E-mail ou senha incorretos.",
    });
  });

  it("keeps demo mode available without sending credentials", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_ALLOW_EXAMPLE_DATA", "true");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { authenticateWithPassword } = await import("@/lib/auth");

    await expect(
      authenticateWithPassword("ana@globo.com", "Senha123"),
    ).resolves.toEqual({ kind: "demo" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("supports the same-origin path prefix used by the existing ingress", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "/api-operacional");
    vi.stubGlobal("window", { location: { origin: "http://dashboard.test" } });
    const { gatewayUrl } = await import("@/lib/data/client");
    expect(gatewayUrl("/api/v1/incidents", { limit: 20 })).toBe(
      "http://dashboard.test/api-operacional/api/v1/incidents?limit=20",
    );
  });

  it("retains partial metadata and request id", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://gateway.test");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { value: 7 }, meta }), { status: 200, headers: { "content-type": "application/json" } })));
    const { loadResource } = await import("@/lib/data/client");
    const resource = await loadResource<{ value: number }, number>({ path: "/api/v1/value", map: (data) => data.value });
    expect(resource).toMatchObject({ data: 7, source: "api", availability: "partial", requestId: "req_frontend", refreshAfterSeconds: 30 });
    expect(resource.warnings[0]?.code).toBe("PARTIAL");
  });

  it("keeps HTTP error requestId and never enables examples implicitly", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://gateway.test");
    vi.stubEnv("NEXT_PUBLIC_ALLOW_EXAMPLE_DATA", "false");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "DATA_UNAVAILABLE", message: "missing", requestId: "req_error" } }), { status: 503 })));
    const { apiGet, composeResource } = await import("@/lib/data/client");
    await expect(apiGet("/api/v1/value")).rejects.toMatchObject({ status: 503, code: "DATA_UNAVAILABLE", requestId: "req_error" });
    const resource = await composeResource({ read: async () => { throw new Error("missing"); }, fallback: () => ({ fabricated: true }) });
    expect(resource.source).toBe("indisponivel");
    expect(resource.data).toBeUndefined();
  });

  it("sends ARGUS mutations as JSON and preserves gateway errors", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://gateway.test");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: "ARGUS_UNAVAILABLE",
        message: "ARGUS indisponível.",
        requestId: "req_argus_error",
      },
    }), { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const { apiPatch } = await import("@/lib/data/client");
    const { ENDPOINTS } = await import("@/lib/data/endpoints");

    await expect(
      apiPatch(ENDPOINTS.argusIntegration, { enabled: true }),
    ).rejects.toMatchObject({
      status: 503,
      code: "ARGUS_UNAVAILABLE",
      message: "ARGUS indisponível.",
      requestId: "req_argus_error",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/integrations/argus"),
      expect.objectContaining({
        method: "PATCH",
        credentials: "include",
        body: JSON.stringify({ enabled: true }),
      }),
    );
    const requestHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(requestHeaders.get("Content-Type")).toBe("application/json");
  });

  it("blocks examples in production even if the public flag is set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_ALLOW_EXAMPLE_DATA", "true");
    const { ALLOW_EXAMPLE_DATA } = await import("@/lib/data/mode");
    expect(ALLOW_EXAMPLE_DATA).toBe(false);
  });
});

describe("human review", () => {
  it("sends hypothesis id and expectedVersion and exposes 409", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://gateway.test");
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), ...(init ? { init } : {}) });
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({ error: { code: "REVIEW_VERSION_CONFLICT", message: "conflict", requestId: "req_conflict" } }), { status: 409 });
      }
      return new Response(JSON.stringify({
        data: {
          incident: { id: "inc_1", title: "Incident", priority: "P1", status: "investigating", startedAt: "2026-01-01T00:00:00Z", impact: { affectedDevices: { value: 2, measurement: { status: "measured" } } }, primaryComponent: null },
          diagnosis: { status: "ready", summary: "summary", primaryHypothesisId: "hyp_7", confidence: 0.8, hypotheses: [{ id: "hyp_7", statement: "Cause", component: null, probability: 0.8, rationale: null, review: { status: "pending", version: 7 } }] },
          evidence: [],
          charts: { buffering: null, concentrations: [] },
        },
        meta,
      }), { status: 200 });
    }));
    const { fetchEvidence, reviewHypothesis } = await import("@/app/(painel)/evidencias/evidence-resource");
    expect((await fetchEvidence("inc_1")).data?.hypothesis).not.toBeNull();
    const result = await reviewHypothesis("inc_1", "confirmed");
    expect(result).toMatchObject({ ok: false, needsSignIn: false });
    expect(requests[1]?.url).toContain("/incidents/inc_1/hypotheses/hyp_7/review");
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({ status: "confirmed", expectedVersion: 7 });
    expect(
      requests.some(({ url }) => url.includes("/api/v1/telemetry/rum")),
    ).toBe(true);
  });
});
