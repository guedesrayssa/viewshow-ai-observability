import { datasetVersionSchema } from "@view-show/contracts";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ActiveDatasetSnapshot } from "../ports/active-dataset-resolver.js";

const versionMapSchema = z.record(z.string().min(1), z.string().min(1));
const utcTimestampSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return (
    !Number.isNaN(parsed.valueOf()) &&
    (value.endsWith("Z") || /[+-]00:00$/.test(value))
  );
}, "Expected a valid UTC timestamp.");
const intervalSchema = z
  .object({ start: utcTimestampSchema, end: utcTimestampSchema })
  .strict()
  .refine((value) => Date.parse(value.start) < Date.parse(value.end), {
    message: "Expected a non-empty half-open interval.",
  });
const availableIntervalsSchema = z.record(
  z.string().min(1),
  z.array(intervalSchema).superRefine((intervals, context) => {
    for (let index = 1; index < intervals.length; index += 1) {
      const previous = intervals[index - 1];
      const current = intervals[index];
      if (
        previous &&
        current &&
        Date.parse(current.start) < Date.parse(previous.end)
      ) {
        context.addIssue({
          code: "custom",
          message: "Intervals must be ordered and non-overlapping.",
        });
      }
    }
  }),
);
const hotFromSchema = z.record(
  z.string().min(1),
  utcTimestampSchema.nullable(),
);

function compareUnicode(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0) ?? 0);
  for (
    let index = 0;
    index < Math.min(leftPoints.length, rightPoints.length);
    index += 1
  ) {
    const difference = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new ActiveDatasetContractError();
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => compareUnicode(left, right),
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new ActiveDatasetContractError();
}

function manifestFingerprint(
  datasetVersion: string,
  metadata: unknown,
): string {
  return createHash("sha256")
    .update(canonicalJson({ datasetVersion, metadata }), "utf8")
    .digest("hex");
}

const activeDatasetItemSchema = z
  .object({
    pk: z.literal("CONTROL#DATASET"),
    sk: z.literal("ACTIVE"),
    entityType: z.literal("ACTIVE_MANIFEST"),
    activeDatasetVersion: datasetVersionSchema,
    manifest: z
      .object({
        datasetVersion: datasetVersionSchema,
        metadata: z
          .object({
            availableIntervals: availableIntervalsSchema,
            formulaVersions: versionMapSchema,
            hotFrom: hotFromSchema,
            projectionVersions: versionMapSchema,
          })
          .superRefine((metadata, context) => {
            const intervalDatasets = Object.keys(
              metadata.availableIntervals,
            ).sort();
            const hotDatasets = Object.keys(metadata.hotFrom).sort();
            if (
              JSON.stringify(intervalDatasets) !== JSON.stringify(hotDatasets)
            ) {
              context.addIssue({
                code: "custom",
                message:
                  "availableIntervals and hotFrom must cover the same datasets.",
              });
              return;
            }
            for (const dataset of intervalDatasets) {
              const intervals = metadata.availableIntervals[dataset] ?? [];
              const hotFrom = metadata.hotFrom[dataset];
              if (intervals.length === 0) {
                if (hotFrom !== null) {
                  context.addIssue({
                    code: "custom",
                    message: "An unavailable dataset must have null hotFrom.",
                  });
                }
                continue;
              }
              const first = intervals[0];
              const last = intervals.at(-1);
              if (
                hotFrom === null ||
                hotFrom === undefined ||
                !first ||
                !last ||
                Date.parse(hotFrom) < Date.parse(first.start) ||
                Date.parse(hotFrom) > Date.parse(last.end)
              ) {
                context.addIssue({
                  code: "custom",
                  message:
                    "hotFrom must lie inside the available interval bounds.",
                });
              }
            }
          })
          .passthrough(),
        fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
  })
  .strict();

export class ActiveDatasetContractError extends Error {
  constructor() {
    super("The ACTIVE dataset manifest does not match the consumed contract.");
    this.name = "ActiveDatasetContractError";
  }
}

export function decodeActiveDatasetItem(item: unknown): ActiveDatasetSnapshot {
  const parsed = activeDatasetItemSchema.safeParse(item);
  if (
    !parsed.success ||
    parsed.data.activeDatasetVersion !== parsed.data.manifest.datasetVersion ||
    parsed.data.manifest.fingerprint !==
      manifestFingerprint(
        parsed.data.manifest.datasetVersion,
        parsed.data.manifest.metadata,
      )
  ) {
    throw new ActiveDatasetContractError();
  }
  return {
    datasetVersion: parsed.data.activeDatasetVersion,
    formulaVersions: parsed.data.manifest.metadata.formulaVersions,
    projectionVersions: parsed.data.manifest.metadata.projectionVersions,
    availableIntervals: parsed.data.manifest.metadata.availableIntervals,
    hotFrom: parsed.data.manifest.metadata.hotFrom,
  };
}
