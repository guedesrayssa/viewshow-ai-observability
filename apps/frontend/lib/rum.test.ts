import { beforeEach, describe, expect, it, vi } from "vitest";

import { normalizedPath, reportRum } from "@/lib/rum";

describe("browser telemetry", () => {
  const sendBeacon = vi.fn(() => true);

  beforeEach(() => {
    sendBeacon.mockClear();
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value: sendBeacon,
    });
  });

  it("normalizes routes before they become metric labels", () => {
    expect(normalizedPath("/incidentes/inc_123/evidencias")).toBe(
      "/incidentes",
    );
    expect(normalizedPath("/")).toBe("/");
  });

  it("sends an allowlisted metric as a JSON beacon", () => {
    reportRum("frontend_web_vitals_lcp_seconds", 1.25, {
      metricId: "lcp-test",
      rating: "good",
    });

    expect(sendBeacon).toHaveBeenCalledOnce();
    const [url, body] = sendBeacon.mock.calls[0] ?? [];
    expect(String(url)).toContain("/api/v1/telemetry/rum");
    expect(body).toBeInstanceOf(Blob);
    expect((body as Blob).type).toBe("application/json");
  });

  it("falls back to a keepalive request when the beacon queue is full", () => {
    sendBeacon.mockReturnValueOnce(false);
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    reportRum("frontend_client_errors_total", 1);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: "/api/v1/telemetry/rum" }),
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        keepalive: true,
      }),
    );
  });
});
