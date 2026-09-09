import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { ServiceError } from "@view-show/contracts";

type CursorPayload = {
  readonly version: 1;
  readonly offset: number;
  readonly fingerprint: string;
};

export class CursorCodec {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = createHash("sha256").update(secret).digest();
  }

  encode(offset: number, fingerprint: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(
        JSON.stringify({
          version: 1,
          offset,
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
        !("offset" in raw) ||
        typeof raw.offset !== "number" ||
        !Number.isInteger(raw.offset) ||
        raw.offset < 0 ||
        !("fingerprint" in raw) ||
        raw.fingerprint !== expectedFingerprint
      ) {
        throw new Error("invalid cursor payload");
      }
      return raw.offset;
    } catch {
      throw new ServiceError(
        400,
        "VALIDATION_ERROR",
        "O cursor é inválido para estes filtros.",
      );
    }
  }
}
