import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { ServiceError } from "@view-show/contracts";

type CursorPayload = {
  readonly version: 1;
  readonly state: unknown;
  readonly fingerprint: string;
};

export class CursorCodec {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = createHash("sha256").update(secret).digest();
  }

  encode(offset: number, fingerprint: string): string {
    return this.encodeState(offset, fingerprint);
  }

  encodeState<T>(state: T, fingerprint: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(
        JSON.stringify({
          version: 1,
          state,
          fingerprint,
        } satisfies CursorPayload),
      ),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      "base64url",
    );
  }

  decode(cursor: string, expectedFingerprint: string): number {
    const state = this.decodeState(cursor, expectedFingerprint);
    if (typeof state !== "number" || !Number.isInteger(state) || state < 0)
      throw new ServiceError(
        400,
        "VALIDATION_ERROR",
        "O cursor é inválido para estes filtros.",
      );
    return state;
  }

  decodeState(cursor: string, expectedFingerprint: string): unknown {
    try {
      const buffer = Buffer.from(cursor, "base64url");
      const iv = buffer.subarray(0, 12);
      const tag = buffer.subarray(12, 28);
      const encrypted = buffer.subarray(28);
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAuthTag(tag);
      const raw: unknown = JSON.parse(
        Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
          "utf8",
        ),
      );
      if (
        raw === null ||
        typeof raw !== "object" ||
        !("version" in raw) ||
        raw.version !== 1 ||
        !("state" in raw) ||
        !("fingerprint" in raw) ||
        raw.fingerprint !== expectedFingerprint
      ) {
        throw new Error("invalid cursor payload");
      }
      return raw.state;
    } catch {
      throw new ServiceError(
        400,
        "VALIDATION_ERROR",
        "O cursor é inválido para estes filtros.",
      );
    }
  }
}
