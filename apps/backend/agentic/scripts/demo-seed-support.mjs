import { readFileSync } from "node:fs";

/**
 * Proteção comum dos scripts de demonstração. Eles gravam fatos sintéticos na
 * tabela operacional e publicam na fila real, então exigem opt-in explícito e
 * destino informado por ambiente, nunca uma conta ou tabela fixa no código.
 */
export function requireDemoSeedEnvironment(names, environment = process.env) {
  if (environment.ALLOW_REMOTE_SEED !== "1") {
    throw new Error(
      "this demo seed writes synthetic data to the live table; set ALLOW_REMOTE_SEED=1 to continue",
    );
  }
  const missing = names.filter((name) => !environment[name]);
  if (missing.length > 0) {
    throw new Error(`missing required environment: ${missing.join(", ")}`);
  }
  return Object.fromEntries(names.map((name) => [name, environment[name]]));
}

/** seriesId por métrica de um escopo, lido do mesmo catálogo entregue ao worker. */
export function catalogSeriesIds(catalogUrl, scopeId) {
  const scopes = JSON.parse(readFileSync(catalogUrl, "utf8"));
  const scope = Array.isArray(scopes)
    ? scopes.find((item) => item?.id === scopeId)
    : undefined;
  if (!scope) throw new Error(`scope ${scopeId} not found in the catalog`);
  return Object.fromEntries(
    scope.series.map((series) => [series.metric, series.seriesId]),
  );
}
