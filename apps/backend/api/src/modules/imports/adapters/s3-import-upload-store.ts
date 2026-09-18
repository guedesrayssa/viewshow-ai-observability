import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { importIdSchema, ServiceError } from "@view-show/contracts";
import type {
  ImportStoredPart,
  ImportUploadPart,
  ImportUploadStore,
} from "../ports/import-upload-store.js";
import { InvalidUploadProgressEvidenceError } from "../ports/import-upload-store.js";

const PART_SIZE = 16 * 1024 * 1024;
const MAX_PARTS = 10_000;
const CHECKSUM_HEADER = "x-amz-checksum-sha256";
const invalid = () =>
  new ServiceError(400, "VALIDATION_ERROR", "Partes da importação inválidas.");
const invalidProgress = () => new InvalidUploadProgressEvidenceError();

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function checksumValid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9+/]{43}=$/.test(value) &&
    Buffer.from(value, "base64").toString("base64") === value
  );
}

function normalizedEtag(value: unknown): string {
  if (!nonempty(value)) throw invalid();
  let tag = value.trim();
  if (tag.startsWith('"') && tag.endsWith('"')) tag = tag.slice(1, -1);
  if (!/^[!#-~]+$/.test(tag)) throw invalid();
  return `"${tag}"`;
}

function validateParts(parts: readonly ImportUploadPart[]): void {
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > MAX_PARTS)
    throw invalid();
  let previous = 0;
  for (const part of parts) {
    if (
      !positiveInteger(part.partNumber) ||
      part.partNumber > MAX_PARTS ||
      part.partNumber <= previous ||
      !checksumValid(part.checksumSha256)
    )
      throw invalid();
    previous = part.partNumber;
  }
}

function concreteVersion(versionId: unknown): asserts versionId is string {
  if (!nonempty(versionId) || versionId.trim() === "null")
    throw new Error("S3 must return a concrete object version.");
}

export class S3ImportUploadStore implements ImportUploadStore {
  private readonly client: S3Client;

  constructor(
    region: string,
    private readonly bucket: string,
    private readonly expectedBucketOwner: string,
    client?: S3Client,
    private readonly signer: typeof getSignedUrl = getSignedUrl,
  ) {
    this.client = client ?? new S3Client({ region });
  }

  private object(key: string) {
    const match =
      /^staging\/imports\/(imp_[0-7][0-9A-HJKMNP-TV-Z]{25})\/source$/.exec(key);
    if (!match) throw invalid();
    return {
      Bucket: this.bucket,
      Key: key,
      ExpectedBucketOwner: this.expectedBucketOwner,
    };
  }

  private upload(key: string, uploadId: string) {
    if (!nonempty(uploadId)) throw invalid();
    return { ...this.object(key), UploadId: uploadId };
  }

  async create(input: Parameters<ImportUploadStore["create"]>[0]) {
    if (!importIdSchema.safeParse(input.importId).success) throw invalid();
    const key = `staging/imports/${input.importId}/source`;
    const result = await this.client.send(
      new CreateMultipartUploadCommand({
        ...this.object(key),
        ChecksumAlgorithm: "SHA256",
        ServerSideEncryption: "AES256",
        // Filenames may contain Unicode/control characters and belong in the repository.
        Metadata: { importId: input.importId },
      }),
    );
    if (!nonempty(result.UploadId))
      throw new Error("S3 omitted the upload ID.");
    return { uploadId: result.UploadId, key };
  }

  async signParts(input: Parameters<ImportUploadStore["signParts"]>[0]) {
    const upload = this.upload(input.key, input.uploadId);
    validateParts(input.parts);
    return Promise.all(
      input.parts.map(async (part) => ({
        partNumber: part.partNumber,
        url: await this.signer(
          this.client,
          new UploadPartCommand({
            ...upload,
            PartNumber: part.partNumber,
            ChecksumSHA256: part.checksumSha256,
          }),
          {
            expiresIn: 15 * 60,
            unhoistableHeaders: new Set([CHECKSUM_HEADER]),
          },
        ),
        headers: { [CHECKSUM_HEADER]: part.checksumSha256 },
      })),
    );
  }

  async listParts(input: Parameters<ImportUploadStore["listParts"]>[0]) {
    const upload = this.upload(input.key, input.uploadId);
    const parts: ImportStoredPart[] = [];
    let marker: string | undefined;
    let previous = 0;
    for (;;) {
      const result = await this.client.send(
        new ListPartsCommand({
          ...upload,
          ...(marker === undefined ? {} : { PartNumberMarker: marker }),
        }),
      );
      if (typeof result.IsTruncated !== "boolean")
        throw new Error("S3 omitted multipart pagination evidence.");
      if (result.Parts !== undefined && !Array.isArray(result.Parts))
        throw new Error("S3 returned malformed multipart evidence.");
      const page = result.Parts ?? [];
      for (const part of page) {
        if (
          !positiveInteger(part.PartNumber) ||
          part.PartNumber > MAX_PARTS ||
          part.PartNumber <= previous ||
          !checksumValid(part.ChecksumSHA256) ||
          !positiveInteger(part.Size) ||
          part.Size > PART_SIZE
        )
          throw invalid();
        parts.push({
          partNumber: part.PartNumber,
          etag: normalizedEtag(part.ETag),
          checksumSha256: part.ChecksumSHA256,
          sizeBytes: part.Size,
        });
        previous = part.PartNumber;
      }
      if (!result.IsTruncated) return parts;
      if (page.length === 0 || result.NextPartNumberMarker !== String(previous))
        throw new Error("S3 returned an invalid multipart pagination marker.");
      marker = result.NextPartNumberMarker;
    }
  }

  async getUploadedProgress(
    input: Parameters<ImportUploadStore["getUploadedProgress"]>[0],
  ) {
    const upload = this.upload(input.key, input.uploadId);
    if (
      input.expectedPartSizeBytes !== PART_SIZE ||
      !positiveInteger(input.expectedSizeBytes) ||
      !positiveInteger(input.expectedPartCount) ||
      input.expectedPartCount > MAX_PARTS ||
      input.expectedPartCount !==
        Math.ceil(input.expectedSizeBytes / input.expectedPartSizeBytes)
    )
      throw invalidProgress();

    const finalPartSize =
      input.expectedSizeBytes -
      input.expectedPartSizeBytes * (input.expectedPartCount - 1);
    if (!positiveInteger(finalPartSize) || finalPartSize > PART_SIZE)
      throw invalidProgress();

    let completedBytes = 0;
    let marker: string | undefined;
    let previousPartNumber = 0;
    for (;;) {
      const result = await this.client.send(
        new ListPartsCommand({
          ...upload,
          ...(marker === undefined ? {} : { PartNumberMarker: marker }),
        }),
      );
      if (
        typeof result.IsTruncated !== "boolean" ||
        (result.Parts !== undefined && !Array.isArray(result.Parts))
      )
        throw invalidProgress();
      const page = result.Parts ?? [];
      for (const part of page) {
        if (
          !positiveInteger(part.PartNumber) ||
          part.PartNumber <= previousPartNumber ||
          part.PartNumber > input.expectedPartCount ||
          !nonempty(part.ETag) ||
          !checksumValid(part.ChecksumSHA256) ||
          !positiveInteger(part.Size)
        )
          throw invalidProgress();
        try {
          normalizedEtag(part.ETag);
        } catch {
          throw invalidProgress();
        }
        const expectedPartSize =
          part.PartNumber === input.expectedPartCount
            ? finalPartSize
            : input.expectedPartSizeBytes;
        if (part.Size !== expectedPartSize) throw invalidProgress();
        const nextCompletedBytes = completedBytes + part.Size;
        if (
          !Number.isSafeInteger(nextCompletedBytes) ||
          nextCompletedBytes > input.expectedSizeBytes
        )
          throw invalidProgress();
        completedBytes = nextCompletedBytes;
        previousPartNumber = part.PartNumber;
      }
      if (!result.IsTruncated) return { completedBytes };
      if (
        page.length === 0 ||
        result.NextPartNumberMarker !== String(previousPartNumber)
      )
        throw invalidProgress();
      marker = result.NextPartNumberMarker;
    }
  }

  async complete(input: Parameters<ImportUploadStore["complete"]>[0]) {
    const upload = this.upload(input.key, input.uploadId);
    validateParts(input.parts);
    if (
      !positiveInteger(input.expectedSizeBytes) ||
      !positiveInteger(input.expectedPartCount) ||
      input.expectedPartCount !== input.parts.length ||
      input.expectedPartCount !== Math.ceil(input.expectedSizeBytes / PART_SIZE)
    )
      throw invalid();
    const manifest = input.parts.map((part, index) => {
      if (part.partNumber !== index + 1) throw invalid();
      return {
        PartNumber: part.partNumber,
        ETag: normalizedEtag(part.etag),
        ChecksumSHA256: part.checksumSha256,
      };
    });
    const stored = await this.listParts(input);
    if (stored.length !== manifest.length) throw invalid();
    let sizeBytes = 0;
    for (const [index, part] of stored.entries()) {
      const requested = manifest[index]!;
      if (
        part.partNumber !== requested.PartNumber ||
        part.etag !== requested.ETag ||
        part.checksumSha256 !== requested.ChecksumSHA256 ||
        (index < stored.length - 1 && part.sizeBytes !== PART_SIZE)
      )
        throw invalid();
      sizeBytes += part.sizeBytes;
    }
    if (sizeBytes !== input.expectedSizeBytes) throw invalid();
    const result = await this.client.send(
      new CompleteMultipartUploadCommand({
        ...upload,
        // S3 checks size atomically; ETag+SHA256 bind the listed bytes if a part changes.
        MpuObjectSize: input.expectedSizeBytes,
        MultipartUpload: { Parts: manifest },
      }),
    );
    concreteVersion(result.VersionId);
    return { versionId: result.VersionId };
  }

  async head(key: string, versionId: string, expectedSizeBytes: number) {
    const object = this.object(key);
    concreteVersion(versionId);
    if (!positiveInteger(expectedSizeBytes)) throw invalid();
    const result = await this.client.send(
      new HeadObjectCommand({ ...object, VersionId: versionId }),
    );
    if (
      !positiveInteger(result.ContentLength) ||
      result.ContentLength !== expectedSizeBytes
    )
      throw invalid();
    return { sizeBytes: result.ContentLength };
  }

  async abort(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand(this.upload(key, uploadId)),
    );
  }

  async recoverCompleted(key: string, expectedSizeBytes: number) {
    const object = this.object(key);
    if (!positiveInteger(expectedSizeBytes)) throw invalid();
    try {
      const result = await this.client.send(new HeadObjectCommand(object));
      concreteVersion(result.VersionId);
      if (
        !positiveInteger(result.ContentLength) ||
        result.ContentLength !== expectedSizeBytes
      )
        throw invalid();
      return { versionId: result.VersionId };
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "NoSuchKey" || error.name === "NotFound")
      )
        return null;
      throw error;
    }
  }
}
