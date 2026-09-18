export interface ImportUploadPart {
  partNumber: number;
  checksumSha256: string;
}

export interface ImportCompletedPart extends ImportUploadPart {
  etag: string;
}

export interface ImportStoredPart extends ImportCompletedPart {
  sizeBytes: number;
}

/** Distinguishes untrustworthy physical evidence from a transient store failure. */
export class InvalidUploadProgressEvidenceError extends Error {
  override readonly name = "InvalidUploadProgressEvidenceError";
}

export interface ImportUploadStore {
  create(input: {
    importId: string;
    fileName: string;
  }): Promise<{ uploadId: string; key: string }>;
  signParts(input: {
    key: string;
    uploadId: string;
    parts: readonly ImportUploadPart[];
  }): Promise<
    readonly {
      partNumber: number;
      url: string;
      headers: Readonly<Record<string, string>>;
    }[]
  >;
  listParts(input: {
    key: string;
    uploadId: string;
  }): Promise<readonly ImportStoredPart[]>;
  /** Returns only the confirmed byte aggregate, never multipart capabilities. */
  getUploadedProgress(input: {
    key: string;
    uploadId: string;
    expectedSizeBytes: number;
    expectedPartCount: number;
    expectedPartSizeBytes: number;
  }): Promise<{ completedBytes: number }>;
  /** Verifies S3 evidence against the manifest and declared upload geometry. */
  complete(input: {
    key: string;
    uploadId: string;
    parts: readonly ImportCompletedPart[];
    expectedSizeBytes: number;
    expectedPartCount: number;
  }): Promise<{ versionId: string }>;
  /** Reads a concrete version and rejects a size mismatch. */
  head(
    key: string,
    versionId: string,
    expectedSizeBytes: number,
  ): Promise<{ sizeBytes: number }>;
  abort(key: string, uploadId: string): Promise<void>;
  /** Only after durable completion intent prevents restart of this import key. */
  recoverCompleted(
    key: string,
    expectedSizeBytes: number,
  ): Promise<{ versionId: string } | null>;
}
