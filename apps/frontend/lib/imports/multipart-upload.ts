import {
  createImportIdempotencyKey,
  type CompleteImportPartInput,
  type ImportClient,
  type MutableControl,
  type SignImportPartInput,
} from "@/lib/imports/client";
import type {
  ImportFile,
  ImportPart,
  ImportSnapshot,
  SignedImportPart,
  UploadProgress,
} from "@/lib/imports/types";

export const IMPORT_PART_SIZE_BYTES = 16 * 1024 * 1024;
export const IMPORT_UPLOAD_CONCURRENCY = 3;
const CHECKSUM_HEADER = "x-amz-checksum-sha256";
const CHECKSUM = /^[A-Za-z0-9+/]{43}=$/;
const PUT_TIMEOUT_MS = 14 * 60 * 1000;

export type MultipartPutRequest = {
  url: string;
  headers: Readonly<Record<string, string>>;
  body: ArrayBuffer;
  signal: AbortSignal;
  onProgress: (loadedBytes: number) => void;
};

export type MultipartPutTransport = (
  request: MultipartPutRequest,
) => Promise<{ etag: string }>;

export type UploadImportClient = Pick<
  ImportClient,
  "listParts" | "signParts" | "restart" | "complete" | "get"
>;

export type UploadImportFileInput = {
  importRecord: ImportSnapshot;
  file: ImportFile;
  client: UploadImportClient;
  signal: AbortSignal;
  onProgress: (progress: UploadProgress) => void;
  onPhase?: (phase: "uploading" | "completing") => void;
  putPart?: MultipartPutTransport;
  digest?: typeof sha256Base64;
  createIdempotencyKey?: (action: "restart" | "complete") => string;
  confirmIdempotencyKey?: (action: "restart" | "complete", key: string) => void;
};

function abortError(): DOMException {
  return new DOMException("A transferência foi cancelada.", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

export async function sha256Base64(
  bytes: ArrayBuffer,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<string> {
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function createXhrPutTransport(
  factory: () => XMLHttpRequest = () => new XMLHttpRequest(),
): MultipartPutTransport {
  return ({ url, headers, body, signal, onProgress }) =>
    new Promise((resolve, reject) => {
      const xhr = factory();
      let settled = false;
      let greatestLoaded = 0;

      const cleanup = () => {
        signal.removeEventListener("abort", onSignalAbort);
        xhr.upload.onprogress = null;
        xhr.onload = null;
        xhr.onerror = null;
        xhr.ontimeout = null;
        xhr.onabort = null;
      };
      const fail = (message: string, name = "UploadError") => {
        if (settled) return;
        settled = true;
        cleanup();
        const error = new Error(message);
        error.name = name;
        reject(error);
      };
      const onSignalAbort = () => {
        if (settled) return;
        xhr.abort();
        fail("A transferência foi cancelada.", "AbortError");
      };

      xhr.open("PUT", url, true);
      xhr.withCredentials = false;
      xhr.timeout = PUT_TIMEOUT_MS;
      for (const [name, value] of Object.entries(headers))
        xhr.setRequestHeader(name, value);
      xhr.upload.onprogress = (event) => {
        const loaded = Math.min(
          body.byteLength,
          Math.max(
            greatestLoaded,
            Number.isFinite(event.loaded) ? event.loaded : 0,
          ),
        );
        greatestLoaded = loaded;
        onProgress(loaded);
      };
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          fail("Não foi possível enviar uma parte do arquivo.");
          return;
        }
        const etag = xhr.getResponseHeader("ETag")?.trim();
        if (!etag) {
          fail("O armazenamento não confirmou a parte enviada.");
          return;
        }
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ etag });
      };
      xhr.onerror = () => fail("Não foi possível enviar uma parte do arquivo.");
      xhr.ontimeout = () =>
        fail("O envio de uma parte excedeu o tempo limite.");
      xhr.onabort = () => fail("A transferência foi cancelada.", "AbortError");
      signal.addEventListener("abort", onSignalAbort, { once: true });
      if (signal.aborted) {
        onSignalAbort();
        return;
      }
      xhr.send(body);
    });
}

function expectedPartSize(
  partNumber: number,
  partCount: number,
  totalBytes: number,
): number {
  return partNumber === partCount
    ? totalBytes - IMPORT_PART_SIZE_BYTES * (partCount - 1)
    : IMPORT_PART_SIZE_BYTES;
}

function evidenceIsCanonical(
  parts: readonly ImportPart[],
  partCount: number,
  totalBytes: number,
): boolean {
  let previous = 0;
  for (const part of parts) {
    if (
      !Number.isSafeInteger(part.partNumber) ||
      part.partNumber <= previous ||
      part.partNumber > partCount ||
      part.sizeBytes !==
        expectedPartSize(part.partNumber, partCount, totalBytes) ||
      !part.etag.trim() ||
      !CHECKSUM.test(part.checksumSha256)
    )
      return false;
    previous = part.partNumber;
  }
  return true;
}

function checksumHeader(part: SignedImportPart): string | undefined {
  for (const [name, value] of Object.entries(part.headers))
    if (name.toLowerCase() === CHECKSUM_HEADER) return value;
  return undefined;
}

function validateSignedWindow(
  requested: readonly SignImportPartInput[],
  signed: readonly SignedImportPart[],
): Map<number, SignedImportPart> {
  if (signed.length !== requested.length)
    throw new Error("A assinatura das partes ficou incompleta.");
  const requestedByNumber = new Map(
    requested.map((part) => [part.partNumber, part.checksumSha256]),
  );
  const result = new Map<number, SignedImportPart>();
  for (const part of signed) {
    const expected = requestedByNumber.get(part.partNumber);
    if (
      expected === undefined ||
      result.has(part.partNumber) ||
      checksumHeader(part) !== expected
    )
      throw new Error("A assinatura das partes ficou inconsistente.");
    result.set(part.partNumber, part);
  }
  return result;
}

function linkAbort(parent: AbortSignal, child: AbortController): () => void {
  const abort = () => child.abort();
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  return () => parent.removeEventListener("abort", abort);
}

function fileIsCompatible(record: ImportSnapshot, file: ImportFile): boolean {
  return file.name === record.fileName && file.size === record.sizeBytes;
}

export async function uploadImportFile({
  importRecord,
  file,
  client,
  signal,
  onProgress,
  onPhase,
  putPart = createXhrPutTransport(),
  digest = sha256Base64,
  createIdempotencyKey: makeKey = createImportIdempotencyKey,
  confirmIdempotencyKey: confirmKey = () => {},
}: UploadImportFileInput): Promise<ImportSnapshot> {
  if (!importRecord.canManageUpload)
    throw new Error("Somente o autor pode enviar ou retomar este arquivo.");
  if (importRecord.state !== "UPLOADING")
    throw new Error("A importação não está aguardando upload.");
  if (!fileIsCompatible(importRecord, file))
    throw new Error("O arquivo selecionado não corresponde à importação.");
  throwIfAborted(signal);

  const partCount = Math.ceil(file.size / IMPORT_PART_SIZE_BYTES);
  if (partCount < 1 || partCount > 10_000)
    throw new Error("O arquivo possui uma geometria de upload inválida.");

  let workingRecord = importRecord;
  const existing = await client.listParts(importRecord.importId, { signal });
  let restartRequired = !evidenceIsCanonical(existing, partCount, file.size);
  const manifest = new Map<number, CompleteImportPartInput>();

  if (!restartRequired) {
    for (
      let offset = 0;
      offset < existing.length && !restartRequired;
      offset += IMPORT_UPLOAD_CONCURRENCY
    ) {
      const window = existing.slice(offset, offset + IMPORT_UPLOAD_CONCURRENCY);
      const checked = await Promise.all(
        window.map(async (part) => {
          throwIfAborted(signal);
          const start = (part.partNumber - 1) * IMPORT_PART_SIZE_BYTES;
          const bytes = await file
            .slice(start, start + part.sizeBytes)
            .arrayBuffer();
          const checksumSha256 = await digest(bytes);
          return { part, checksumSha256 };
        }),
      );
      for (const checkedPart of checked) {
        if (checkedPart.checksumSha256 !== checkedPart.part.checksumSha256) {
          restartRequired = true;
          break;
        }
        manifest.set(checkedPart.part.partNumber, {
          partNumber: checkedPart.part.partNumber,
          etag: checkedPart.part.etag,
          checksumSha256: checkedPart.checksumSha256,
        });
      }
    }
  }

  if (restartRequired) {
    throwIfAborted(signal);
    const restartKey = makeKey("restart");
    workingRecord = await client.restart(importRecord.importId, {
      idempotencyKey: restartKey,
      signal,
    });
    confirmKey("restart", restartKey);
    if (
      workingRecord.state !== "UPLOADING" ||
      !workingRecord.canManageUpload ||
      !fileIsCompatible(workingRecord, file)
    )
      throw new Error("A API não confirmou o reinício do upload.");
    manifest.clear();
  }

  const partSizes = new Map<number, number>();
  for (let partNumber = 1; partNumber <= partCount; partNumber += 1)
    partSizes.set(
      partNumber,
      expectedPartSize(partNumber, partCount, file.size),
    );
  let confirmedBytes = [...manifest.keys()].reduce(
    (sum, partNumber) => sum + (partSizes.get(partNumber) ?? 0),
    0,
  );
  const inFlight = new Map<number, number>();
  const emit = () =>
    onProgress({
      confirmedBytes,
      inFlightBytes: Math.min(
        file.size - confirmedBytes,
        [...inFlight.values()].reduce((sum, value) => sum + value, 0),
      ),
      totalBytes: file.size,
    });
  emit();
  onPhase?.("uploading");

  const missing: number[] = [];
  for (let partNumber = 1; partNumber <= partCount; partNumber += 1)
    if (!manifest.has(partNumber)) missing.push(partNumber);

  for (
    let offset = 0;
    offset < missing.length;
    offset += IMPORT_UPLOAD_CONCURRENCY
  ) {
    throwIfAborted(signal);
    const numbers = missing.slice(offset, offset + IMPORT_UPLOAD_CONCURRENCY);
    const payloads = await Promise.all(
      numbers.map(async (partNumber) => {
        const sizeBytes = partSizes.get(partNumber);
        if (sizeBytes === undefined)
          throw new Error("A geometria das partes ficou incompleta.");
        const start = (partNumber - 1) * IMPORT_PART_SIZE_BYTES;
        const body = await file.slice(start, start + sizeBytes).arrayBuffer();
        const checksumSha256 = await digest(body);
        if (!CHECKSUM.test(checksumSha256))
          throw new Error("O navegador gerou um checksum inválido.");
        return { partNumber, sizeBytes, body, checksumSha256 };
      }),
    );
    const requested = payloads.map(({ partNumber, checksumSha256 }) => ({
      partNumber,
      checksumSha256,
    }));
    const signed = validateSignedWindow(
      requested,
      await client.signParts(workingRecord.importId, requested, { signal }),
    );
    const windowController = new AbortController();
    const unlink = linkAbort(signal, windowController);
    let firstError: unknown;
    const results = await Promise.all(
      payloads.map(async (payload) => {
        const signedPart = signed.get(payload.partNumber);
        if (!signedPart)
          throw new Error("A assinatura das partes ficou incompleta.");
        try {
          const result = await putPart({
            url: signedPart.url,
            headers: signedPart.headers,
            body: payload.body,
            signal: windowController.signal,
            onProgress: (loadedBytes) => {
              const previous = inFlight.get(payload.partNumber) ?? 0;
              inFlight.set(
                payload.partNumber,
                Math.min(
                  payload.sizeBytes,
                  Math.max(previous, Math.max(0, loadedBytes)),
                ),
              );
              emit();
            },
          });
          const etag = result.etag.trim();
          if (!etag || etag.length > 1024)
            throw new Error("O armazenamento devolveu um ETag inválido.");
          return { ...payload, etag };
        } catch (error) {
          if (firstError === undefined) firstError = error;
          windowController.abort();
          return null;
        }
      }),
    );
    unlink();
    if (firstError !== undefined) throw firstError;
    for (const result of results) {
      if (!result)
        throw new Error("O armazenamento não confirmou todas as partes.");
      inFlight.delete(result.partNumber);
      confirmedBytes += result.sizeBytes;
      manifest.set(result.partNumber, {
        partNumber: result.partNumber,
        etag: result.etag,
        checksumSha256: result.checksumSha256,
      });
    }
    emit();
  }

  const completed: CompleteImportPartInput[] = [];
  for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
    const part = manifest.get(partNumber);
    if (!part) throw new Error("O manifesto final ficou incompleto.");
    completed.push(part);
  }
  onPhase?.("completing");
  const completeControl: MutableControl = {
    idempotencyKey: makeKey("complete"),
    signal,
  };
  try {
    const result = await client.complete(
      workingRecord.importId,
      completed,
      completeControl,
    );
    confirmKey("complete", completeControl.idempotencyKey);
    return result;
  } catch (error) {
    throwIfAborted(signal);
    try {
      const durable = await client.get(workingRecord.importId, { signal });
      if (durable.state !== "UPLOADING") {
        confirmKey("complete", completeControl.idempotencyKey);
        return durable;
      }
    } catch {
      // Keep the original completion failure; it carries the actionable scope.
    }
    throw error;
  }
}
