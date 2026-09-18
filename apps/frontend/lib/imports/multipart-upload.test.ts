import { webcrypto } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createXhrPutTransport,
  sha256Base64,
  uploadImportFile,
  type MultipartPutRequest,
} from "@/lib/imports/multipart-upload";
import type {
  ImportPart,
  ImportSnapshot,
  SignedImportPart,
} from "@/lib/imports/types";

const MiB = 1024 * 1024;
const checksum16 = "A".repeat(43) + "=";
const checksum8 = "B".repeat(43) + "=";

function snapshot(overrides: Partial<ImportSnapshot> = {}): ImportSnapshot {
  return {
    importId: "imp_01K5BB9WQ6EJ5V6TVCMSK74NQ3",
    requestedBy: "usr_owner",
    author: { id: "usr_owner", name: "Maria", email: null },
    canManageUpload: true,
    fileName: "argus_dump.sql.gz",
    sizeBytes: 40 * MiB,
    snapshotExtractedOn: "2026-09-17",
    createdAt: "2026-09-17T10:00:00.000Z",
    updatedAt: "2026-09-17T10:00:00.000Z",
    state: "UPLOADING",
    version: 2,
    progress: { kind: "bytes", completedBytes: 0, totalBytes: 40 * MiB },
    candidateVersion: null,
    error: null,
    ...overrides,
  };
}

function fakeFile(size = 40 * MiB, name = "argus_dump.sql.gz") {
  const slices: Array<{ start: number; end: number }> = [];
  return {
    name,
    size,
    slices,
    slice(start: number, end: number) {
      slices.push({ start, end });
      return {
        arrayBuffer: async () => new ArrayBuffer(end - start),
      };
    },
  };
}

const digest = vi.fn(async (bytes: ArrayBuffer) =>
  bytes.byteLength === 8 * MiB ? checksum8 : checksum16,
);

function signed(
  parts: readonly { partNumber: number; checksumSha256: string }[],
): SignedImportPart[] {
  return parts.map((part) => ({
    partNumber: part.partNumber,
    url: `https://signed.invalid/part-${part.partNumber}?secret=never-log`,
    headers: { "x-amz-checksum-sha256": part.checksumSha256 },
    expiresAt: "2026-09-17T10:15:00.000Z",
  }));
}

function clientFixture(parts: ImportPart[] = []) {
  const complete = vi.fn(async () =>
    snapshot({ state: "UPLOADED", version: 3 }),
  );
  const restart = vi.fn(async () => snapshot({ version: 3 }));
  return {
    listParts: vi.fn(async () => parts),
    signParts: vi.fn(
      async (
        _id: string,
        requested: Array<{ partNumber: number; checksumSha256: string }>,
      ) => signed(requested),
    ),
    restart,
    complete,
    get: vi.fn(async () => snapshot()),
  };
}

describe("checksum e transporte XHR", () => {
  it("calcula SHA-256 WebCrypto canônico em base64", async () => {
    const bytes = new TextEncoder().encode("abc");
    await expect(
      sha256Base64(bytes.buffer, webcrypto.subtle as SubtleCrypto),
    ).resolves.toBe("ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=");
  });

  it("faz PUT sem cookies, aplica exatamente os headers e normaliza progresso", async () => {
    const xhr = new FakeXhr();
    const transport = createXhrPutTransport(() => xhr.asXmlHttpRequest());
    const progress: number[] = [];
    const request = transport({
      url: "https://signed.invalid/private?uploadId=secret",
      headers: {
        "x-amz-checksum-sha256": checksum16,
        "x-amz-meta-test": "ok",
      },
      body: new ArrayBuffer(10),
      signal: new AbortController().signal,
      onProgress: (loaded) => progress.push(loaded),
    });

    xhr.progress(7);
    xhr.progress(3);
    xhr.progress(99);
    xhr.succeed('"etag-1"');

    await expect(request).resolves.toEqual({ etag: '"etag-1"' });
    expect(xhr.opened).toEqual({
      method: "PUT",
      url: "https://signed.invalid/private?uploadId=secret",
      async: true,
    });
    expect(xhr.withCredentials).toBe(false);
    expect(xhr.timeout).toBeGreaterThan(0);
    expect(xhr.headers).toEqual([
      ["x-amz-checksum-sha256", checksum16],
      ["x-amz-meta-test", "ok"],
    ]);
    expect(progress).toEqual([7, 7, 10]);
    expect(xhr.upload.onprogress).toBeNull();
    expect(xhr.onload).toBeNull();
    expect(xhr.onerror).toBeNull();
    expect(xhr.ontimeout).toBeNull();
    expect(xhr.onabort).toBeNull();
  });

  it.each(["http", "missing-etag", "error", "timeout", "abort"])(
    "falha de forma genérica e sem URL em %s",
    async (kind) => {
      const xhr = new FakeXhr();
      const transport = createXhrPutTransport(() => xhr.asXmlHttpRequest());
      const controller = new AbortController();
      const request = transport({
        url: "https://signed.invalid/private?uploadId=secret",
        headers: { "x-amz-checksum-sha256": checksum16 },
        body: new ArrayBuffer(1),
        signal: controller.signal,
        onProgress: () => {},
      });
      if (kind === "http") xhr.finish(500, '"etag"');
      if (kind === "missing-etag") xhr.finish(200, null);
      if (kind === "error") xhr.onerror?.(new Event("error"));
      if (kind === "timeout") xhr.ontimeout?.(new Event("timeout"));
      if (kind === "abort") controller.abort();

      const error = await request.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain("signed.invalid");
      expect((error as Error).message).not.toContain("uploadId");
      if (kind === "abort") expect(xhr.abortCalls).toBe(1);
    },
  );
});

describe("uploadImportFile", () => {
  it("envia 40 MiB como 16/16/8, no máximo três PUTs, e conclui manifesto ordenado", async () => {
    const file = fakeFile();
    const client = clientFixture();
    const progress: number[] = [];
    const putRequests: MultipartPutRequest[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const putPart = vi.fn(async (request: MultipartPutRequest) => {
      putRequests.push(request);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      request.onProgress(request.body.byteLength / 2);
      if (concurrent === 3) release();
      await gate;
      request.onProgress(request.body.byteLength);
      concurrent -= 1;
      const partNumber = Number(request.url.match(/part-(\d+)/)?.[1]);
      return { etag: `"etag-${partNumber}"` };
    });

    const result = await uploadImportFile({
      importRecord: snapshot(),
      file,
      client,
      signal: new AbortController().signal,
      digest,
      putPart,
      createIdempotencyKey: (action) => `${action}-key`,
      onProgress: (value) =>
        progress.push(value.confirmedBytes + value.inFlightBytes),
    });

    expect(result.state).toBe("UPLOADED");
    expect(file.slices).toEqual([
      { start: 0, end: 16 * MiB },
      { start: 16 * MiB, end: 32 * MiB },
      { start: 32 * MiB, end: 40 * MiB },
    ]);
    expect(putRequests.map((request) => request.body.byteLength)).toEqual([
      16 * MiB,
      16 * MiB,
      8 * MiB,
    ]);
    expect(maxConcurrent).toBe(3);
    expect(client.signParts).toHaveBeenCalledWith(
      snapshot().importId,
      [
        { partNumber: 1, checksumSha256: checksum16 },
        { partNumber: 2, checksumSha256: checksum16 },
        { partNumber: 3, checksumSha256: checksum8 },
      ],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(
      putRequests.map((request) => request.headers["x-amz-checksum-sha256"]),
    ).toEqual([checksum16, checksum16, checksum8]);
    expect(client.complete).toHaveBeenCalledWith(
      snapshot().importId,
      [
        { partNumber: 1, etag: '"etag-1"', checksumSha256: checksum16 },
        { partNumber: 2, etag: '"etag-2"', checksumSha256: checksum16 },
        { partNumber: 3, etag: '"etag-3"', checksumSha256: checksum8 },
      ],
      expect.objectContaining({ idempotencyKey: "complete-key" }),
    );
    expect(progress.at(-1)).toBe(40 * MiB);
    expect(
      progress.every(
        (value, index) => index === 0 || value >= progress[index - 1]!,
      ),
    ).toBe(true);
    expect(Math.max(...progress)).toBe(40 * MiB);
  });

  it("conserva parte retomada cujo tamanho e checksum conferem", async () => {
    const part: ImportPart = {
      partNumber: 1,
      etag: '"persisted-etag"',
      checksumSha256: checksum16,
      sizeBytes: 16 * MiB,
    };
    const client = clientFixture([part]);
    const uploaded: number[] = [];

    await uploadImportFile({
      importRecord: snapshot(),
      file: fakeFile(),
      client,
      signal: new AbortController().signal,
      digest,
      putPart: async (request) => {
        const number = Number(request.url.match(/part-(\d+)/)?.[1]);
        uploaded.push(number);
        return { etag: `"etag-${number}"` };
      },
      createIdempotencyKey: (action) => `${action}-key`,
      onProgress: () => {},
    });

    expect(uploaded).toEqual([2, 3]);
    expect(client.restart).not.toHaveBeenCalled();
    expect(client.complete.mock.calls[0]?.[1][0]).toEqual({
      partNumber: 1,
      etag: '"persisted-etag"',
      checksumSha256: checksum16,
    });
  });

  it("não lê a quarta parte até liberar a janela de três buffers", async () => {
    const size = 56 * MiB;
    const file = fakeFile(size);
    const client = clientFixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let maxActive = 0;
    const putPart = vi.fn(async (request: MultipartPutRequest) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
      const number = Number(request.url.match(/part-(\d+)/)?.[1]);
      return { etag: `"etag-${number}"` };
    });

    const upload = uploadImportFile({
      importRecord: snapshot({
        sizeBytes: size,
        progress: { kind: "bytes", completedBytes: 0, totalBytes: size },
      }),
      file,
      client,
      signal: new AbortController().signal,
      digest,
      putPart,
      onProgress: () => {},
    });
    await vi.waitFor(() => expect(putPart).toHaveBeenCalledTimes(3));
    expect(file.slices).toHaveLength(3);

    release();
    await upload;
    expect(file.slices).toHaveLength(4);
    expect(maxActive).toBe(3);
    expect(client.signParts.mock.calls.map((call) => call[1].length)).toEqual([
      3, 1,
    ]);
  });

  it("reinicia a geração inteira ao encontrar checksum divergente", async () => {
    const client = clientFixture([
      {
        partNumber: 1,
        etag: '"foreign"',
        checksumSha256: checksum8,
        sizeBytes: 16 * MiB,
      },
    ]);
    const uploaded: number[] = [];

    await uploadImportFile({
      importRecord: snapshot(),
      file: fakeFile(),
      client,
      signal: new AbortController().signal,
      digest,
      putPart: async (request) => {
        const number = Number(request.url.match(/part-(\d+)/)?.[1]);
        uploaded.push(number);
        return { etag: `"etag-${number}"` };
      },
      createIdempotencyKey: (action) => `${action}-key`,
      onProgress: () => {},
    });

    expect(client.restart).toHaveBeenCalledWith(
      snapshot().importId,
      expect.objectContaining({ idempotencyKey: "restart-key" }),
    );
    expect(uploaded.sort()).toEqual([1, 2, 3]);
  });

  it("consome a chave após restart confirmado e usa outra em divergência posterior", async () => {
    const mismatched: ImportPart = {
      partNumber: 1,
      etag: '"foreign"',
      checksumSha256: checksum8,
      sizeBytes: 16 * MiB,
    };
    const client = clientFixture([mismatched]);
    let sequence = 0;
    let pendingRestartKey: string | null = null;
    const getKey = vi.fn((action: "restart" | "complete") => {
      if (action === "restart") {
        pendingRestartKey ??= `restart-key-${++sequence}`;
        return pendingRestartKey;
      }
      return "complete-key";
    });
    const confirmKey = vi.fn((action: "restart" | "complete", key: string) => {
      if (action === "restart" && pendingRestartKey === key)
        pendingRestartKey = null;
    });
    const common = {
      importRecord: snapshot(),
      file: fakeFile(),
      client,
      signal: new AbortController().signal,
      digest,
      createIdempotencyKey: getKey,
      confirmIdempotencyKey: confirmKey,
      onProgress: () => {},
    };

    await expect(
      uploadImportFile({
        ...common,
        putPart: async () => {
          throw new Error("put failed after confirmed restart");
        },
      }),
    ).rejects.toThrow(/put failed/i);
    await uploadImportFile({
      ...common,
      signal: new AbortController().signal,
      putPart: async (request) => ({
        etag: `"etag-${request.url.match(/part-(\d+)/)?.[1]}"`,
      }),
    });

    const restartKeys = client.restart.mock.calls.map(
      (call) => call[1].idempotencyKey,
    );
    expect(restartKeys).toEqual(["restart-key-1", "restart-key-2"]);
    expect(confirmKey).toHaveBeenCalledWith("restart", "restart-key-1");
    expect(confirmKey).toHaveBeenCalledWith("restart", "restart-key-2");
  });

  it("preserva a chave quando a resposta do restart é incerta", async () => {
    const client = clientFixture([
      {
        partNumber: 1,
        etag: '"foreign"',
        checksumSha256: checksum8,
        sizeBytes: 16 * MiB,
      },
    ]);
    client.restart
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(snapshot());
    let pending = "restart-uncertain";
    const getKey = vi.fn((action: "restart" | "complete") =>
      action === "restart" ? pending : "complete-key",
    );
    const confirmKey = vi.fn((action: "restart" | "complete", key: string) => {
      if (action === "restart" && key === pending) pending = "restart-next";
    });
    const common = {
      importRecord: snapshot(),
      file: fakeFile(),
      client,
      digest,
      createIdempotencyKey: getKey,
      confirmIdempotencyKey: confirmKey,
      onProgress: () => {},
    };

    await expect(
      uploadImportFile({ ...common, signal: new AbortController().signal }),
    ).rejects.toThrow(/failed to fetch/i);
    await uploadImportFile({
      ...common,
      signal: new AbortController().signal,
      putPart: async () => ({ etag: '"etag"' }),
    });

    expect(
      client.restart.mock.calls.map((call) => call[1].idempotencyKey),
    ).toEqual(["restart-uncertain", "restart-uncertain"]);
    expect(
      confirmKey.mock.calls.filter(([action]) => action === "restart"),
    ).toEqual([["restart", "restart-uncertain"]]);
  });

  it("falha antes de listar se arquivo/nome ou ownership forem incompatíveis", async () => {
    const client = clientFixture();
    await expect(
      uploadImportFile({
        importRecord: snapshot(),
        file: fakeFile(39 * MiB),
        client,
        signal: new AbortController().signal,
        digest,
        onProgress: () => {},
      }),
    ).rejects.toThrow(/arquivo/i);
    await expect(
      uploadImportFile({
        importRecord: snapshot({ canManageUpload: false }),
        file: fakeFile(),
        client,
        signal: new AbortController().signal,
        digest,
        onProgress: () => {},
      }),
    ).rejects.toThrow(/autor/i);
    expect(client.listParts).not.toHaveBeenCalled();
  });

  it("aborta PUTs irmãos e nunca conclui quando um envio falha", async () => {
    const client = clientFixture();
    let abortedSiblings = 0;
    const putPart = vi.fn((request: MultipartPutRequest) => {
      const number = Number(request.url.match(/part-(\d+)/)?.[1]);
      if (number === 1) return Promise.reject(new Error("put failed"));
      return new Promise<{ etag: string }>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => {
          abortedSiblings += 1;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });

    await expect(
      uploadImportFile({
        importRecord: snapshot(),
        file: fakeFile(),
        client,
        signal: new AbortController().signal,
        digest,
        putPart,
        onProgress: () => {},
      }),
    ).rejects.toThrow();
    expect(abortedSiblings).toBe(2);
    expect(client.complete).not.toHaveBeenCalled();
  });
});

class FakeXhr {
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = {
    onprogress: null,
  };
  onload: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  ontimeout: ((event: Event) => void) | null = null;
  onabort: ((event: Event) => void) | null = null;
  withCredentials = true;
  timeout = 0;
  status = 0;
  opened: { method: string; url: string; async: boolean } | null = null;
  headers: Array<[string, string]> = [];
  abortCalls = 0;
  private etag: string | null = null;

  asXmlHttpRequest() {
    return this as unknown as XMLHttpRequest;
  }
  open(method: string, url: string, async: boolean) {
    this.opened = { method, url, async };
  }
  setRequestHeader(name: string, value: string) {
    this.headers.push([name, value]);
  }
  send() {}
  abort() {
    this.abortCalls += 1;
    this.onabort?.(new Event("abort"));
  }
  getResponseHeader(name: string) {
    return name.toLowerCase() === "etag" ? this.etag : null;
  }
  progress(loaded: number) {
    this.upload.onprogress?.({ loaded } as ProgressEvent);
  }
  finish(status: number, etag: string | null) {
    this.status = status;
    this.etag = etag;
    this.onload?.(new Event("load"));
  }
  succeed(etag: string) {
    this.finish(200, etag);
  }
}
