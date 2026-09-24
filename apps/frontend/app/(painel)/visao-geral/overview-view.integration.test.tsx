/** Integration between the Visão Geral, its resource, and the gateway client. */

import { render, screen } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://operacional.test");
  vi.stubEnv("NEXT_PUBLIC_ALLOW_EXAMPLE_DATA", "false");
});

import { OverviewView } from "@/app/(painel)/visao-geral/overview-view";

const successBody = {
  data: {
    kpis: [
      {
        key: "affected_sessions",
        value: 10920,
        unit: "sessions",
        status: "critical",
        comparison: null,
        measurement: { status: "measured" },
      },
    ],
    experienceHealth: {
      baselineValue: 74,
      points: [{ timestamp: "2026-09-09T12:00:00.000Z", value: 342 }],
      anomalyWindows: [],
    },
    recentIncidents: [
      {
        id: "inc_1",
        title: "Buffering em Smart TVs",
        priority: "P1",
        status: "investigating",
        startedAt: "2026-09-09T11:45:00.000Z",
        affectedSessions: {
          value: 10920,
          measurement: { status: "measured" },
        },
      },
    ],
  },
  meta: {
    requestId: "req_1",
    schemaVersion: "1.0",
    generatedAt: "2026-09-09T12:00:00.000Z",
    window: {
      preset: "30m",
      from: "2026-09-09T11:30:00.000Z",
      to: "2026-09-09T12:00:00.000Z",
    },
    partial: false,
    refreshAfterSeconds: 900,
    freshness: [],
    warnings: [],
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("Visão Geral integrated with the gateway", () => {
  it("loads the complete screen with one canonical overview request", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(successBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<OverviewView />);

    expect(await screen.findByText("Sessões afetadas")).toBeInTheDocument();
    expect(screen.getByText("Buffering em Smart TVs")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://operacional.test/api/v1/dashboard/overview?window=24h",
    );
  });

  it("shows explicit unavailable states when the overview request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );

    const { container } = render(<OverviewView />);

    expect(
      await screen.findByText("Indicadores indisponíveis"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Incidentes recentes indisponíveis"),
    ).toBeInTheDocument();
    expect(container.querySelectorAll(".skeleton").length).toBe(0);
    const requestedUrls = vi
      .mocked(globalThis.fetch)
      .mock.calls.map(([input]) => String(input));
    expect(
      requestedUrls.filter((url) => url.includes("/api/v1/dashboard/overview")),
    ).toHaveLength(1);
    expect(
      requestedUrls.filter((url) => url.includes("/api/v1/telemetry/rum")),
    ).toHaveLength(1);
  });
});
