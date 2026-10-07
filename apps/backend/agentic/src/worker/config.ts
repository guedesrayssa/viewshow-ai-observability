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
    if (value.materiality !== undefined && (!Array.isArray(value.materiality) || !value.materiality.length || value.materiality.some(rule =>
      !object(rule) || typeof rule.metric !== "string" || !seriesValues.some(series => object(series) && series.metric === rule.metric && series.grainSeconds === 900) ||
      typeof rule.minimum !== "number" || !Number.isFinite(rule.minimum) || rule.minimum < 0))) throw new AnalysisError("INVALID_MATERIALITY_RULE", true);
    if (value.episodeWindowSeconds !== undefined && (!Number.isInteger(value.episodeWindowSeconds) || Number(value.episodeWindowSeconds) < 900 || Number(value.episodeWindowSeconds) > 21600))
      throw new AnalysisError("INVALID_EPISODE_WINDOW", true);
    if (value.presentation !== undefined) {
      if (!object(value.presentation)) throw new AnalysisError("INVALID_PRESENTATION_CONFIG", true);
      const presentation = value.presentation;
      const bufferingMetric = presentation.bufferingMetric;
      if (bufferingMetric !== undefined && (typeof bufferingMetric !== "string" || !seriesValues.some(series =>
        object(series) && series.metric === bufferingMetric && series.grainSeconds === 900)))
        throw new AnalysisError("INVALID_PRESENTATION_BUFFERING_METRIC", true);
      if (presentation.bufferingScale !== undefined &&
        (typeof presentation.bufferingScale !== "number" || !Number.isFinite(presentation.bufferingScale) || presentation.bufferingScale <= 0))
        throw new AnalysisError("INVALID_PRESENTATION_BUFFERING_SCALE", true);
      const affectedDevicesMetric = presentation.affectedDevicesMetric;
      if (affectedDevicesMetric !== undefined && (typeof affectedDevicesMetric !== "string" || !seriesValues.some(series =>
        object(series) && series.metric === affectedDevicesMetric && series.grainSeconds === 900)))
        throw new AnalysisError("INVALID_PRESENTATION_AFFECTED_DEVICES_METRIC", true);
      if (presentation.concentrations !== undefined) {
        if (!Array.isArray(presentation.concentrations) || !presentation.concentrations.length || presentation.concentrations.length > 12)
          throw new AnalysisError("INVALID_PRESENTATION_CONCENTRATIONS", true);
        const metrics = new Set<string>();
        const labels = new Set<string>();
        for (const concentration of presentation.concentrations) {
          if (!object(concentration) || typeof concentration.metric !== "string" ||
            typeof concentration.label !== "string" || !concentration.label.trim() ||
            metrics.has(concentration.metric) || labels.has(concentration.label) ||
            !seriesValues.some(series => object(series) && series.metric === concentration.metric && series.grainSeconds === 900))
            throw new AnalysisError("INVALID_PRESENTATION_CONCENTRATIONS", true);
          metrics.add(concentration.metric); labels.add(concentration.label);
        }
      }
      if (presentation.concentrationNote !== undefined &&
        (typeof presentation.concentrationNote !== "string" || presentation.concentrationNote.length > 240))
        throw new AnalysisError("INVALID_PRESENTATION_CONCENTRATION_NOTE", true);
      if (bufferingMetric === undefined && affectedDevicesMetric === undefined && presentation.concentrations === undefined)
        throw new AnalysisError("EMPTY_PRESENTATION_CONFIG", true);
    }
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
