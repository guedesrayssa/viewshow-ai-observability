import { describe, expect, it, vi } from "vitest";
import { ServiceError } from "@view-show/contracts";
import { CursorCodec } from "../src/modules/incidents/domain/cursor.js";
import {
  latestHypothesis,
  toDiagnosisData,
  toIncidentDto,
} from "../src/modules/incidents/domain/incident.js";
import { SessionCodec } from "../src/modules/auth/domain/session.js";
import { IdentityUseCases } from "../src/modules/auth/application/identity-use-cases.js";
import type { IdentityProviderPort } from "../src/modules/auth/ports/identity-provider.js";

const incident = {
  itemType: "incident",
  id: "inc_opaque",
  title: "Falha real",
  priority: "P1",
  status: "investigating",
  startedAt: "2026-01-01T00:00:00Z",
  affectedDevices: 12,
  deviceType: "smart-tv",
};

describe("domain values", () => {
  it("returns the authorization URL and completed identity from its provider", async () => {
    const provider: IdentityProviderPort = {
      async beginAuthorization() {
        return "https://identity.example.test/authorize";
      },
      async completeAuthorization(code, state) {
        if (code !== "code_1" || state !== "state_1") return null;
        return {
          id: "usr_1",
          email: "engineer@example.test",
          name: "Engineer",
          role: "engineer",
        };
      },
    };
    const useCases = new IdentityUseCases(provider);

    await expect(useCases.beginLogin()).resolves.toBe(
      "https://identity.example.test/authorize",
    );
    await expect(
      useCases.completeLogin("code_1", "state_1"),
    ).resolves.toMatchObject({
      id: "usr_1",
      email: "engineer@example.test",
    });
  });

  it("reports the federated provider as unavailable when it has no authorization flow", async () => {
    const provider: IdentityProviderPort = {
      beginAuthorization: vi.fn(async () => null),
      completeAuthorization: vi.fn(async () => null),
    };

    await expect(
      new IdentityUseCases(provider).beginLogin(),
    ).rejects.toMatchObject({
      status: 503,
      code: "FEATURE_UNAVAILABLE",
    });
    await expect(
      new IdentityUseCases(provider).completeLogin("code_1", "state_1"),
    ).rejects.toMatchObject({ status: 503, code: "FEATURE_UNAVAILABLE" });
  });

  it("encrypts cursors and binds them to filters", () => {
    const codec = new CursorCodec("a".repeat(32));
    const cursor = codec.encode(20, "filter-a");
    expect(cursor).not.toContain("filter-a");
    expect(codec.decode(cursor, "filter-a")).toBe(20);
    expect(() => codec.decode(cursor, "filter-b")).toThrowError(ServiceError);
    const tampered = `${cursor[0] === "A" ? "B" : "A"}${cursor.slice(1)}`;
    expect(() => codec.decode(tampered, "filter-a")).toThrowError(ServiceError);
  });

  it("verifies session expiry and signature server-side", () => {
    const codec = new SessionCodec("b".repeat(32), 60);
    const issued = codec.issue(
      {
        id: "usr_1",
        email: "engineer@example.test",
        name: "Engineer",
        role: "engineer",
      },
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(codec.verify(issued, new Date("2026-01-01T00:00:30Z"))?.id).toBe(
      "usr_1",
    );
    expect(codec.verify(issued, new Date("2026-01-01T00:01:01Z"))).toBeNull();
    expect(
      codec.verify(`${issued}tampered`, new Date("2026-01-01T00:00:30Z")),
    ).toBeNull();
  });

  it("maps persisted records without physical keys and selects versions explicitly", () => {
    const hypothesisV1 = {
      itemType: "hypothesis",
      id: "hyp_1",
      version: 1,
      statement: "First",
      probability: 0.3,
      pk: "hidden",
      sk: "hidden",
    };
    const hypothesisV2 = {
      itemType: "hypothesis",
      id: "hyp_2",
      version: 2,
      statement: "Second",
      probability: 0.8,
      pk: "hidden",
      sk: "hidden",
    };
    expect(latestHypothesis([hypothesisV1, hypothesisV2])).toBe(hypothesisV2);
    const dto = toIncidentDto(incident, [hypothesisV1, hypothesisV2]);
    expect(dto).not.toHaveProperty("pk");
    expect(dto.diagnosis.primaryHypothesisId).toBe("hyp_2");
    const diagnosis = toDiagnosisData(incident, [hypothesisV1, hypothesisV2]);
    expect(JSON.stringify(diagnosis)).not.toMatch(/"(?:pk|sk|ttl)"/);
  });

  it("exposes persisted diagnosis charts and timeline in the public response", () => {
    const timestamp = "2026-01-01T00:00:00Z";
    const diagnosis = toDiagnosisData({
      ...incident,
      diagnosisProjection: {
        buffering: {
          points: [{ timestamp, value: 3.2 }],
          marker: { timestamp, label: "Degradação" },
        },
        concentrations: [{ label: "smart-tv", percentage: 68 }],
        concentrationNote: "Dispositivos afetados",
        timeline: [{ timestamp, label: "Detecção", source: "Argus", tone: "critical" }],
        changes: [{ label: "Provável", cause: "player", percentage: 72, tone: "warning" }],
      },
    }, [{ itemType: "evidence", id: "evi_1", statement: "Desvio observado" }]);

    expect(diagnosis.charts.buffering?.points).toEqual([{ timestamp: "2026-01-01T00:00:00.000Z", value: 3.2 }]);
    expect(diagnosis.charts.concentrations).toEqual([{ label: "smart-tv", percentage: 68 }]);
    expect(diagnosis.timeline).toHaveLength(1);
    expect(diagnosis.changes).toHaveLength(1);
    expect(diagnosis.dataQuality.status).toBe("sufficient");
    expect(JSON.stringify(diagnosis)).not.toMatch(/"(?:pk|sk|ttl|diagnosisProjection)"/);
  });

  it("fails incomplete required incident facts instead of inventing values", () => {
    expect(() =>
      toIncidentDto({ id: "inc_bad", title: "Missing facts" }),
    ).toThrow();
  });
});
