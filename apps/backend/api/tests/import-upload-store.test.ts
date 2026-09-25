import { describe, expect, it, vi } from "vitest";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { S3ImportUploadStore } from "../src/modules/imports/adapters/s3-import-upload-store.js";

const importId = "imp_01K5BB9WQ6EJ5V6TVCMSK74NQ3";
const key = `staging/imports/${importId}/source`;
const checksum = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const otherChecksum = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
const MiB16 = 16_777_216;
const identity = { key, uploadId: "upload-1" };
const owner = {
  Bucket: "imports",
  Key: key,
  ExpectedBucketOwner: "123456789012",
};
const manifest = [
  { partNumber: 1, etag: '"etag-1"', checksumSha256: checksum },
  { partNumber: 2, etag: "etag-2", checksumSha256: otherChecksum },
];
const evidence = [
  { PartNumber: 1, ETag: '"etag-1"', ChecksumSHA256: checksum, Size: MiB16 },
  { PartNumber: 2, ETag: '"etag-2"', ChecksumSHA256: otherChecksum, Size: 13 },
];
const completeInput = {
  ...identity,
  parts: manifest,
  expectedSizeBytes: MiB16 + 13,
  expectedPartCount: 2,
};
function setup() {
  const send = vi.fn().mockResolvedValue({});
  const signer = vi.fn().mockResolvedValue("https://signed.example/part");
  const client = { send } as unknown as S3Client;
  return {
    send,
    signer,
    client,
    store: new S3ImportUploadStore(
      "us-east-1",
      "imports",
      "123456789012",
      client,
      signer,
    ),
  };
}
function prepareComplete(
  send: ReturnType<typeof vi.fn>,
  response = { VersionId: "version-1" },
) {
  send
    .mockResolvedValueOnce({ Parts: evidence, IsTruncated: false })
    .mockResolvedValueOnce(response);
}

describe("checksum-bound S3 import uploads", () => {
  it("recovers a completed canonical object using its concrete version and exact size", async () => {
    const { store, send } = setup();
    send.mockResolvedValue({
      VersionId: "recovered-version",
      ContentLength: 13,
    });
    expect(await store.recoverCompleted(key, 13)).toEqual({
      versionId: "recovered-version",
    });
    expect(send.mock.calls[0]![0]).toBeInstanceOf(HeadObjectCommand);
    expect(send.mock.calls[0]![0].input).toEqual(owner);
  });
  it.each([
    { VersionId: "null", ContentLength: 13 },
    { VersionId: "", ContentLength: 13 },
    { VersionId: "valid", ContentLength: 14 },
    { ContentLength: 13 },
  ])("rejects insufficient recovery evidence %j", async (evidence) => {
    const { store, send } = setup();
    send.mockResolvedValue(evidence);
    await expect(store.recoverCompleted(key, 13)).rejects.toThrow();
  });
  it.each(["NoSuchKey", "NotFound"])(
    "treats only %s as an absent completed object",
    async (name) => {
      const { store, send } = setup();
      send.mockRejectedValue(Object.assign(new Error("absent"), { name }));
      expect(await store.recoverCompleted(key, 13)).toBeNull();
    },
  );
  it("does not treat access/network failures as missing recovery evidence", async () => {
    const { store, send } = setup();
    const error = Object.assign(new Error("denied"), { name: "AccessDenied" });
    send.mockRejectedValue(error);
    await expect(store.recoverCompleted(key, 13)).rejects.toBe(error);
  });
  it("creates only the canonical encrypted SHA256 upload with safe metadata", async () => {
    const { store, send } = setup();
    send.mockResolvedValue({ UploadId: "upload-1" });
    expect(
      await store.create({ importId, fileName: "dados ç\r\n.zip" }),
    ).toEqual(identity);
    expect(send.mock.calls[0]![0]).toBeInstanceOf(CreateMultipartUploadCommand);
    expect(send.mock.calls[0]![0].input).toEqual({
      ...owner,
      ChecksumAlgorithm: "SHA256",
      ServerSideEncryption: "AES256",
      Metadata: { importId },
    });
  });

  it.each([
    "../other",
    "imp_invalid",
    "imp_81K5BB9WQ6EJ5V6TVCMSK74NQ3",
    `${importId}/other`,
  ])("rejects invalid import IDs before creation: %s", async (invalidId) => {
    const { store, send } = setup();
    await expect(
      store.create({ importId: invalidId, fileName: "dump.zip" }),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it.each([undefined, "", " "])(
    "rejects missing upload IDs from S3: %s",
    async (UploadId) => {
      const { store, send } = setup();
      send.mockResolvedValue({ UploadId });
      await expect(
        store.create({ importId, fileName: "dump.zip" }),
      ).rejects.toThrow();
    },
  );

  it("signs checksum-bound parts for exactly fifteen minutes and returns required headers", async () => {
    const { store, signer, client, send } = setup();
    expect(
      await store.signParts({
        ...identity,
        parts: [{ partNumber: 3, checksumSha256: checksum }],
      }),
    ).toEqual([
      {
        partNumber: 3,
        url: "https://signed.example/part",
        headers: { "x-amz-checksum-sha256": checksum },
      },
    ]);
    const [signedClient, command, options] = signer.mock.calls[0]!;
    expect(signedClient).toBe(client);
    expect(command).toBeInstanceOf(UploadPartCommand);
    expect(command.input).toEqual({
      ...owner,
      UploadId: "upload-1",
      PartNumber: 3,
      ChecksumSHA256: checksum,
    });
    expect(options).toEqual({
      expiresIn: 900,
      unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("uses the actual SDK signer to bind owner, checksum header, part and expiry", async () => {
    const client = new S3Client({
      region: "us-east-1",
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
    const store = new S3ImportUploadStore(
      "us-east-1",
      "imports",
      "123456789012",
      client,
    );
    const [part] = await store.signParts({
      ...identity,
      parts: [{ partNumber: 1, checksumSha256: checksum }],
    });
    const url = new URL(part!.url);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain(
      "x-amz-checksum-sha256",
    );
    expect(url.searchParams.get("x-amz-expected-bucket-owner")).toBe(
      "123456789012",
    );
    expect(url.searchParams.get("partNumber")).toBe("1");
    expect(url.searchParams.get("uploadId")).toBe("upload-1");
    client.destroy();
  });

  it.each([[], [1, 1], [2, 1], [0], [10_001], [1.5], [NaN]])(
    "rejects empty, duplicate, unordered or invalid signing parts %j",
    async (...numbers) => {
      const { store, signer } = setup();
      await expect(
        store.signParts({
          ...identity,
          parts: numbers.map((partNumber) => ({
            partNumber,
            checksumSha256: checksum,
          })),
        }),
      ).rejects.toThrow();
      expect(signer).not.toHaveBeenCalled();
    },
  );

  it.each(["", "abc", "A".repeat(44), "A".repeat(42) + "B="])(
    "rejects invalid or noncanonical SHA256 %s",
    async (checksumSha256) => {
      const { store, signer } = setup();
      await expect(
        store.signParts({
          ...identity,
          parts: [{ partNumber: 1, checksumSha256 }],
        }),
      ).rejects.toThrow();
      expect(signer).not.toHaveBeenCalled();
    },
  );

  it.each([
    "other/source",
    `staging/imports/${importId}/other`,
    `staging/imports/../source`,
    `${key}/..`,
    `${key}\n`,
  ])("rejects arbitrary object keys on every operation: %s", async (badKey) => {
    const { store, send, signer } = setup();
    await expect(
      store.signParts({ ...identity, key: badKey, parts: manifest }),
    ).rejects.toThrow();
    await expect(
      store.listParts({ ...identity, key: badKey }),
    ).rejects.toThrow();
    await expect(
      store.complete({ ...completeInput, key: badKey }),
    ).rejects.toThrow();
    await expect(store.head(badKey, "version", 1)).rejects.toThrow();
    await expect(store.abort(badKey, "upload")).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(signer).not.toHaveBeenCalled();
  });

  it("paginates evidence, preserving checksums, sizes and canonical ETags", async () => {
    const { store, send } = setup();
    send
      .mockResolvedValueOnce({
        Parts: [evidence[0]],
        IsTruncated: true,
        NextPartNumberMarker: "1",
      })
      .mockResolvedValueOnce({ Parts: [evidence[1]], IsTruncated: false });
    expect(await store.listParts(identity)).toEqual([
      {
        partNumber: 1,
        etag: '"etag-1"',
        checksumSha256: checksum,
        sizeBytes: MiB16,
      },
      {
        partNumber: 2,
        etag: '"etag-2"',
        checksumSha256: otherChecksum,
        sizeBytes: 13,
      },
    ]);
    expect(
      send.mock.calls.every(([command]) => command instanceof ListPartsCommand),
    ).toBe(true);
    expect(send.mock.calls.map(([command]) => command.input)).toEqual([
      { ...owner, UploadId: "upload-1" },
      { ...owner, UploadId: "upload-1", PartNumberMarker: "1" },
    ]);
  });

  it("allows an explicitly empty upload listing", async () => {
    const { store, send } = setup();
    send.mockResolvedValue({ IsTruncated: false });
    expect(await store.listParts(identity)).toEqual([]);
  });

  it("aggregates paginated sparse parts using their part-number geometry", async () => {
    const { store, send } = setup();
    send
      .mockResolvedValueOnce({
        Parts: [evidence[0]],
        IsTruncated: true,
        NextPartNumberMarker: "1",
      })
      .mockResolvedValueOnce({
        Parts: [
          {
            PartNumber: 3,
            ETag: '"etag-3"',
            ChecksumSHA256: checksum,
            Size: 13,
          },
        ],
        IsTruncated: false,
      });

    await expect(
      store.getUploadedProgress({
        ...identity,
        expectedSizeBytes: 2 * MiB16 + 13,
        expectedPartCount: 3,
        expectedPartSizeBytes: MiB16,
      }),
    ).resolves.toEqual({ completedBytes: MiB16 + 13 });
    expect(send.mock.calls.map(([command]) => command.input)).toEqual([
      { ...owner, UploadId: "upload-1" },
      { ...owner, UploadId: "upload-1", PartNumberMarker: "1" },
    ]);
  });

  it("rejects out-of-order S3 evidence even when each part has valid geometry", async () => {
    const { store, send } = setup();
    send.mockResolvedValue({
      Parts: [
        {
          PartNumber: 3,
          ETag: '"etag-3"',
          ChecksumSHA256: checksum,
          Size: 13,
        },
        evidence[0],
      ],
      IsTruncated: false,
    });

    await expect(
      store.getUploadedProgress({
        ...identity,
        expectedSizeBytes: 2 * MiB16 + 13,
        expectedPartCount: 3,
        expectedPartSizeBytes: MiB16,
      }),
    ).rejects.toThrow();
  });

  it("rejects a truncated page whose marker skips its last listed part", async () => {
    const { store, send } = setup();
    send
      .mockResolvedValueOnce({
        Parts: [evidence[0]],
        IsTruncated: true,
        NextPartNumberMarker: "2",
      })
      .mockResolvedValueOnce({
        Parts: [
          {
            PartNumber: 3,
            ETag: '"etag-3"',
            ChecksumSHA256: checksum,
            Size: 13,
          },
        ],
        IsTruncated: false,
      });

    await expect(
      store.getUploadedProgress({
        ...identity,
        expectedSizeBytes: 2 * MiB16 + 13,
        expectedPartCount: 3,
        expectedPartSizeBytes: MiB16,
      }),
    ).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([1, 2])(
    "rejects aggregate part %s after a previous page ended at part 2",
    async (partNumber) => {
      const { store, send } = setup();
      send
        .mockResolvedValueOnce({
          Parts: [{ ...evidence[1], PartNumber: 2, Size: MiB16 }],
          IsTruncated: true,
          NextPartNumberMarker: "2",
        })
        .mockResolvedValueOnce({
          Parts: [{ ...evidence[0], PartNumber: partNumber }],
          IsTruncated: false,
        });

      await expect(
        store.getUploadedProgress({
          ...identity,
          expectedSizeBytes: 2 * MiB16 + 13,
          expectedPartCount: 3,
          expectedPartSizeBytes: MiB16,
        }),
      ).rejects.toThrow();
    },
  );

  it.each([
    {
      input: {
        expectedSizeBytes: 2 * MiB16 + 13,
        expectedPartCount: 2,
        expectedPartSizeBytes: MiB16,
      },
      response: { Parts: [], IsTruncated: false },
    },
    {
      input: {
        expectedSizeBytes: 2 * MiB16 + 13,
        expectedPartCount: 3,
        expectedPartSizeBytes: MiB16 - 1,
      },
      response: { Parts: [], IsTruncated: false },
    },
    {
      input: {
        expectedSizeBytes: 2 * MiB16 + 13,
        expectedPartCount: 3,
        expectedPartSizeBytes: MiB16,
      },
      response: {
        Parts: [{ ...evidence[0], Size: MiB16 - 1 }],
        IsTruncated: false,
      },
    },
    {
      input: {
        expectedSizeBytes: 2 * MiB16 + 13,
        expectedPartCount: 3,
        expectedPartSizeBytes: MiB16,
      },
      response: {
        Parts: [{ ...evidence[1], PartNumber: 3, Size: 14 }],
        IsTruncated: false,
      },
    },
    {
      input: {
        expectedSizeBytes: 2 * MiB16 + 13,
        expectedPartCount: 3,
        expectedPartSizeBytes: MiB16,
      },
      response: {
        Parts: [{ ...evidence[0], PartNumber: 4 }],
        IsTruncated: false,
      },
    },
    {
      input: {
        expectedSizeBytes: 2 * MiB16 + 13,
        expectedPartCount: 3,
        expectedPartSizeBytes: MiB16,
      },
      response: {
        Parts: [evidence[0], evidence[0]],
        IsTruncated: false,
      },
    },
    {
      input: {
        expectedSizeBytes: 2 * MiB16 + 13,
        expectedPartCount: 3,
        expectedPartSizeBytes: MiB16,
      },
      response: {
        Parts: [{ ...evidence[0], ChecksumSHA256: undefined }],
        IsTruncated: false,
      },
    },
    {
      input: {
        expectedSizeBytes: 2 * MiB16 + 13,
        expectedPartCount: 3,
        expectedPartSizeBytes: MiB16,
      },
      response: {
        Parts: [{ ...evidence[0], ETag: undefined }],
        IsTruncated: false,
      },
    },
    {
      input: {
        expectedSizeBytes: 10_001 * MiB16,
        expectedPartCount: 10_001,
        expectedPartSizeBytes: MiB16,
      },
      response: { Parts: [], IsTruncated: false },
    },
  ])(
    "rejects invalid aggregate geometry or malformed physical evidence %#",
    async ({ input, response }) => {
      const { store, send } = setup();
      send.mockResolvedValue(response);
      await expect(
        store.getUploadedProgress({ ...identity, ...input }),
      ).rejects.toThrow();
    },
  );

  it.each([
    {},
    { Parts: null, IsTruncated: false },
    { Parts: [evidence[0]] },
    { Parts: [], IsTruncated: true, NextPartNumberMarker: "1" },
    { Parts: [evidence[0]], IsTruncated: true },
    {
      Parts: [evidence[0]],
      IsTruncated: true,
      NextPartNumberMarker: "0",
    },
    {
      Parts: [evidence[0]],
      IsTruncated: true,
      NextPartNumberMarker: "4",
    },
  ])("rejects malformed aggregate pagination evidence %j", async (response) => {
    const { store, send } = setup();
    send.mockResolvedValue(response);
    await expect(
      store.getUploadedProgress({
        ...identity,
        expectedSizeBytes: 2 * MiB16 + 13,
        expectedPartCount: 3,
        expectedPartSizeBytes: MiB16,
      }),
    ).rejects.toThrow();
  });

  it.each([
    {},
    { Parts: null, IsTruncated: false },
    { Parts: {}, IsTruncated: false },
    { Parts: evidence },
    { Parts: evidence, IsTruncated: true },
    { Parts: evidence, IsTruncated: true, NextPartNumberMarker: "0" },
    { Parts: evidence, IsTruncated: true, NextPartNumberMarker: "3" },
    { Parts: [], IsTruncated: true, NextPartNumberMarker: "1" },
    { Parts: [evidence[0], evidence[0]], IsTruncated: false },
    { Parts: [evidence[1], evidence[0]], IsTruncated: false },
    ...[undefined, "", "bad"].map((ETag) => ({
      Parts: [{ ...evidence[0], ETag: ETag === "bad" ? '"bad' : ETag }],
      IsTruncated: false,
    })),
    ...[undefined, "bad"].map((ChecksumSHA256) => ({
      Parts: [{ ...evidence[0], ChecksumSHA256 }],
      IsTruncated: false,
    })),
    ...[undefined, 0, -1, 1.5, MiB16 + 1].map((Size) => ({
      Parts: [{ ...evidence[0], Size }],
      IsTruncated: false,
    })),
    ...[undefined, 0, 10_001].map((PartNumber) => ({
      Parts: [{ ...evidence[0], PartNumber }],
      IsTruncated: false,
    })),
  ])("rejects malformed or incomplete S3 listing %j", async (response) => {
    const { store, send } = setup();
    send.mockResolvedValue(response);
    await expect(store.listParts(identity)).rejects.toThrow();
  });

  it("rejects duplicate evidence across page boundaries", async () => {
    const { store, send } = setup();
    send
      .mockResolvedValueOnce({
        Parts: [evidence[0]],
        IsTruncated: true,
        NextPartNumberMarker: "1",
      })
      .mockResolvedValueOnce({ Parts: [evidence[0]], IsTruncated: false });
    await expect(store.listParts(identity)).rejects.toThrow();
  });

  it("completes the verified manifest with atomic object-size enforcement and returns a concrete version", async () => {
    const { store, send } = setup();
    prepareComplete(send);
    expect(await store.complete(completeInput)).toEqual({
      versionId: "version-1",
    });
    const command = send.mock.calls[1]![0];
    expect(command).toBeInstanceOf(CompleteMultipartUploadCommand);
    expect(command.input).toEqual({
      ...owner,
      UploadId: "upload-1",
      MpuObjectSize: MiB16 + 13,
      MultipartUpload: {
        Parts: [
          { PartNumber: 1, ETag: '"etag-1"', ChecksumSHA256: checksum },
          { PartNumber: 2, ETag: '"etag-2"', ChecksumSHA256: otherChecksum },
        ],
      },
    });
  });

  it.each([
    { expectedSizeBytes: MiB16 + 14 },
    { expectedSizeBytes: 0 },
    { expectedSizeBytes: NaN },
    { expectedSizeBytes: undefined },
    { expectedPartCount: undefined },
    { expectedPartCount: 1 },
    { expectedPartCount: 0 },
    { expectedPartCount: 1.5 },
    { parts: [] },
    { parts: [manifest[0], manifest[0]] },
    { parts: [...manifest].reverse() },
    {
      parts: [
        { ...manifest[0], partNumber: 2 },
        { ...manifest[1], partNumber: 3 },
      ],
    },
    { parts: [{ ...manifest[0], etag: "wrong" }, manifest[1]] },
    { parts: [{ ...manifest[0], checksumSha256: otherChecksum }, manifest[1]] },
  ])("never completes inconsistent requested evidence: %j", async (changes) => {
    const { store, send } = setup();
    prepareComplete(send);
    await expect(
      store.complete({ ...completeInput, ...changes } as typeof completeInput),
    ).rejects.toThrow();
    expect(
      send.mock.calls.some(
        ([command]) => command instanceof CompleteMultipartUploadCommand,
      ),
    ).toBe(false);
  });

  it.each([
    [evidence[0]],
    [
      { ...evidence[0], Size: MiB16 - 1 },
      { ...evidence[1], Size: 14 },
    ],
    [{ ...evidence[0], ETag: '"changed"' }, evidence[1]],
    [{ ...evidence[0], ChecksumSHA256: otherChecksum }, evidence[1]],
    [evidence[0], { ...evidence[1], PartNumber: 3 }],
  ])(
    "never completes incomplete or mismatched stored evidence: %j",
    async (...parts) => {
      const { store, send } = setup();
      send.mockResolvedValue({ Parts: parts, IsTruncated: false });
      await expect(store.complete(completeInput)).rejects.toThrow();
      expect(
        send.mock.calls.some(
          ([command]) => command instanceof CompleteMultipartUploadCommand,
        ),
      ).toBe(false);
    },
  );

  it.each([undefined, "", " ", "null"])(
    "rejects a missing or null concrete version: %s",
    async (VersionId) => {
      const { store, send } = setup();
      send
        .mockResolvedValueOnce({ Parts: evidence, IsTruncated: false })
        .mockResolvedValueOnce({ VersionId });
      await expect(store.complete(completeInput)).rejects.toThrow();
    },
  );

  it("heads the exact version and validates its byte length", async () => {
    const { store, send } = setup();
    send.mockResolvedValue({ ContentLength: 13 });
    expect(await store.head(key, "version-1", 13)).toEqual({ sizeBytes: 13 });
    expect(send.mock.calls[0]![0]).toBeInstanceOf(HeadObjectCommand);
    expect(send.mock.calls[0]![0].input).toEqual({
      ...owner,
      VersionId: "version-1",
    });
  });

  it.each([undefined, -1, 12, 14, NaN])(
    "rejects absent or mismatched head size: %s",
    async (ContentLength) => {
      const { store, send } = setup();
      send.mockResolvedValue({ ContentLength });
      await expect(store.head(key, "version-1", 13)).rejects.toThrow();
    },
  );

  it.each(["", " ", "null"])(
    "rejects nonconcrete head versions: %s",
    async (versionId) => {
      const { store, send } = setup();
      await expect(store.head(key, versionId, 13)).rejects.toThrow();
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("aborts only the canonical upload under the expected owner", async () => {
    const { store, send } = setup();
    await store.abort(key, "upload-1");
    expect(send.mock.calls[0]![0]).toBeInstanceOf(AbortMultipartUploadCommand);
    expect(send.mock.calls[0]![0].input).toEqual({
      ...owner,
      UploadId: "upload-1",
    });
  });

  it("preserves S3 and signing failures", async () => {
    const { store, send, signer } = setup();
    const failure = new Error("S3 unavailable");
    send.mockRejectedValue(failure);
    signer.mockRejectedValue(failure);
    await expect(store.create({ importId, fileName: "dump.zip" })).rejects.toBe(
      failure,
    );
    await expect(
      store.signParts({ ...identity, parts: manifest }),
    ).rejects.toBe(failure);
    await expect(store.listParts(identity)).rejects.toBe(failure);
    await expect(store.complete(completeInput)).rejects.toBe(failure);
    await expect(store.head(key, "version", 13)).rejects.toBe(failure);
    await expect(store.abort(key, "upload-1")).rejects.toBe(failure);
  });

  it("preserves a failure returned by CompleteMultipartUpload after listing succeeds", async () => {
    const { store, send } = setup();
    const failure = new Error("complete unavailable");
    send
      .mockResolvedValueOnce({ Parts: evidence, IsTruncated: false })
      .mockRejectedValueOnce(failure);

    await expect(store.complete(completeInput)).rejects.toBe(failure);
    expect(send.mock.calls[1]![0]).toBeInstanceOf(
      CompleteMultipartUploadCommand,
    );
  });
});
