import { createHash } from "node:crypto";

export interface SeriesIdentity {
  logicalDataset: string;
  source: string;
  entity: string;
  metric: string;
  dimensions?: Record<string, string>;
}

/** Contrato compartilhado entre ingestão e análise para localizar a mesma série. */
export function canonicalSeriesIdentity(input: SeriesIdentity): string {
  const dimensions = Object.entries(input.dimensions ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({ logicalDataset: input.logicalDataset, source: input.source, entity: input.entity, metric: input.metric, dimensions });
}

export function seriesId(input: SeriesIdentity): string {
  return `ts_${createHash("sha256").update(canonicalSeriesIdentity(input)).digest("hex")}`;
}
