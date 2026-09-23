import { readFile } from "node:fs/promises";
import { AnalysisError, type AnalysisScope } from "./types.js";
import { validateBundle, type ModelBundle } from "./models.js";

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function validateScopes(raw: unknown): AnalysisScope[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 32) throw new AnalysisError("INVALID_SCOPE_CATALOG", true);
  const ids = new Set<string>();
  return raw.map(value => {
    if (!object(value) || typeof value.id !== "string" || !value.id || ids.has(value.id) || typeof value.source !== "string" ||
      typeof value.entity !== "string" || !["P1", "P2", "P3", "P4"].includes(String(value.priority)) ||
      !Array.isArray(value.series) || !value.series.length || value.series.length > 32 || !Array.isArray(value.detectorMetrics))
      throw new AnalysisError("INVALID_SCOPE_CATALOG", true);
    ids.add(value.id);
    const seriesValues = value.series as unknown[];
    const metricGrains = new Set<string>(), seriesIds = new Set<string>();
    for (const series of seriesValues) {
      const metricGrain = object(series) ? `${String(series.metric)}:${String(series.grainSeconds)}` : "";
      if (!object(series) || typeof series.metric !== "string" || !series.metric || metricGrains.has(metricGrain) ||
        typeof series.seriesId !== "string" || !series.seriesId || seriesIds.has(series.seriesId) || typeof series.unit !== "string" || !series.unit ||
        !Number.isInteger(series.grainSeconds) || ![900, 3600].includes(Number(series.grainSeconds))) throw new AnalysisError("INVALID_SCOPE_SERIES", true);
      metricGrains.add(metricGrain); seriesIds.add(series.seriesId);
    }
    if (value.detectorMetrics.some(metric => typeof metric !== "string" || !seriesValues.some(series => object(series) && series.metric === metric && series.grainSeconds === 900))) throw new AnalysisError("INVALID_DETECTOR_METRIC", true);
    return value as unknown as AnalysisScope;
  });
}

export async function loadWorkerFiles(modelPath: string, catalogPath: string, allowUnapproved = false): Promise<{ model: ModelBundle; scopes: AnalysisScope[] }> {
  let modelText: string, catalogText: string;
  try { [modelText, catalogText] = await Promise.all([readFile(modelPath, "utf8"), readFile(catalogPath, "utf8")]); }
  catch (error) { throw new AnalysisError(`CONFIG_FILE_ERROR:${(error as Error).message}`, true); }
  return parseWorkerDocuments(modelText!, catalogText!, allowUnapproved);
}

export function parseWorkerDocuments(modelText: string, catalogText: string, allowUnapproved = false): { model: ModelBundle; scopes: AnalysisScope[] } {
  try { return { model: validateBundle(JSON.parse(modelText), allowUnapproved), scopes: validateScopes(JSON.parse(catalogText)) }; }
  catch (error) { if (error instanceof AnalysisError) throw error; throw new AnalysisError(`CONFIG_PARSE_ERROR:${(error as Error).message}`, true); }
}
