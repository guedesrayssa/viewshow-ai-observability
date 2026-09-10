export interface ImportControlPort {
  start(input: {
    fileName: string;
    sizeBytes: number;
    sha256: string;
    partCount: number;
    requestedBy: string;
  }): Promise<"unavailable">;
  complete(input: {
    importId: string;
    parts: readonly { partNumber: number; etag: string }[];
    requestedBy: string;
  }): Promise<"unavailable">;
  get(importId: string, requestedBy: string): Promise<"unavailable">;
}
