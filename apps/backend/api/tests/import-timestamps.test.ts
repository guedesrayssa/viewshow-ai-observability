import { readFileSync } from "node:fs";
import {
  importSnapshotSchema,
  signImportPartsResponseSchema,
} from "@view-show/contracts";
import { expect, it } from "vitest";

const timestamps: {
  valid: { input: string; utc: string }[];
  invalid: string[];
} = JSON.parse(
  readFileSync(
    new URL(
      "../../ingestion-data/tests/fixtures/import_timestamps.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const openapi = JSON.parse(
  readFileSync(
    new URL("../contracts/openapi/public.openapi.json", import.meta.url),
    "utf8",
  ),
);
const properties = openapi.components.schemas;
const openapiTimestamps = [
  properties.ImportSnapshot.properties.createdAt,
  properties.ImportSnapshot.properties.updatedAt,
  properties.SignedImportParts.properties.parts.items.properties.expiresAt,
];

function validForAllSchemas(value: string): boolean[] {
  return [
    importSnapshotSchema.shape.createdAt.safeParse(value).success,
    importSnapshotSchema.shape.updatedAt.safeParse(value).success,
    signImportPartsResponseSchema.safeParse({
      parts: [
        {
          partNumber: 1,
          url: "https://upload.example.test/part",
          headers: {},
          expiresAt: value,
        },
      ],
    }).success,
  ];
}

it.each(timestamps.invalid)(
  "rejects noncanonical import timestamp %s",
  (value) => {
    expect(validForAllSchemas(value)).toEqual([false, false, false]);
    for (const schema of openapiTimestamps) {
      expect(schema.pattern).toBeTypeOf("string");
      expect(new RegExp(schema.pattern).test(value)).toBe(false);
    }
  },
);

it.each(timestamps.valid)(
  "accepts exact milliseconds with explicit offset: $input",
  ({ input, utc }) => {
    expect(validForAllSchemas(input)).toEqual([true, true, true]);
    expect(new Date(input).toISOString()).toBe(utc);
    for (const schema of openapiTimestamps) {
      expect(schema.pattern).toBeTypeOf("string");
      expect(new RegExp(schema.pattern).test(input)).toBe(true);
    }
  },
);
