import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { AuthenticatedIdentity } from "@view-show/contracts";

interface SessionPayload extends AuthenticatedIdentity {
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly sessionId: string;
}

export class SessionCodec {
  constructor(
    private readonly secret: string,
    private readonly lifetimeSeconds = 8 * 60 * 60,
  ) {}

  issue(identity: AuthenticatedIdentity, now = new Date()): string {
    const issuedAt = Math.floor(now.getTime() / 1000);
    const payload: SessionPayload = {
      ...identity,
      issuedAt,
      expiresAt: issuedAt + this.lifetimeSeconds,
      sessionId: randomUUID(),
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
      "base64url",
    );
    const signature = createHmac("sha256", this.secret)
      .update(encoded)
      .digest("base64url");
    return `${encoded}.${signature}`;
  }

  verify(
    value: string | undefined,
    now = new Date(),
  ): AuthenticatedIdentity | null {
    if (!value) return null;
    const [encoded, signature] = value.split(".");
    if (!encoded || !signature) return null;
    const expected = createHmac("sha256", this.secret)
      .update(encoded)
      .digest("base64url");
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (
      actualBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(actualBuffer, expectedBuffer)
    )
      return null;
    try {
      const payload: unknown = JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf8"),
      );
      if (payload === null || typeof payload !== "object") return null;
      const record = payload as Record<string, unknown>;
      if (
        typeof record.id !== "string" ||
        typeof record.email !== "string" ||
        typeof record.expiresAt !== "number" ||
        record.expiresAt <= Math.floor(now.getTime() / 1000)
      )
        return null;
      if (
        record.role !== "viewer" &&
        record.role !== "engineer" &&
        record.role !== "admin"
      )
        return null;
      return {
        id: record.id,
        email: record.email,
        name: typeof record.name === "string" ? record.name : null,
        role: record.role,
      };
    } catch {
      return null;
    }
  }
}

export function parseCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  if (!header) return undefined;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    try {
      if (decodeURIComponent(pair.slice(0, separator).trim()) === name)
        return decodeURIComponent(pair.slice(separator + 1).trim());
    } catch {
      continue;
    }
  }
  return undefined;
}
