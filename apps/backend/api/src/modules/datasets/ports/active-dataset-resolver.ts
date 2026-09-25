import type { DatasetVersion } from "@view-show/contracts";

export interface ActiveDatasetSnapshot {
  readonly datasetVersion: DatasetVersion;
  readonly formulaVersions: Readonly<Record<string, string>>;
  readonly projectionVersions: Readonly<Record<string, string>>;
  readonly availableIntervals: Readonly<
    Record<string, readonly { readonly start: string; readonly end: string }[]>
  >;
  readonly hotFrom: Readonly<Record<string, string | null>>;
}

export interface ActiveDatasetResolver {
  resolve(): Promise<ActiveDatasetSnapshot | null>;
}
