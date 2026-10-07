/**
 * Checks de CONTEÚDO usados pelos cenários A/B/G de `consultas.js` além do
 * `status === 200` — o que a Seção 4 ("Testes de Carga Funcional") de
 * artefatos/sprint4/testes-funcionais.md pede além da vazão/latência já
 * medidas nativamente pelo k6: schema mínimo da resposta, ausência de
 * campo físico vazado, ausência de duplicidade entre páginas e correlação
 * de X-Request-Id.
 *
 * Deliberadamente NÃO reusa os schemas Zod de `@view-show/contracts`: o
 * runtime do k6 (goja) não é Node e não roda Zod. As checagens abaixo são
 * uma forma mínima manual, não uma revalidação completa do contrato — a
 * validação completa já é feita pelos testes funcionais HTTP da Seção 3
 * (`tests/incidents-aws-live.functional.test.ts`), que rodam sob Vitest/Node.
 */
import { check } from "k6";

const PHYSICAL_FIELD_PATTERN = /"(pk|sk|ttl|trace_id)":/;

const VALID_PRIORITIES = new Set(["P1", "P2", "P3", "P4"]);

/** Nenhum campo físico de persistência (pk/sk/ttl/trace_id) deve vazar no
 *  corpo — mesma regra validada em tests/domain.test.ts para o DTO. */
export function checkNoPhysicalFields(res, rotulo) {
  return check(res, {
    [`${rotulo}: sem campo físico vazado`]: (r) =>
      r.status !== 200 || !PHYSICAL_FIELD_PATTERN.test(r.body),
  });
}

/** A API ecoa o X-Request-Id recebido (src/app.ts, requestIdentifier()) —
 *  se o valor devolvido não bate com o enviado, algo na cadeia (proxy, ALB,
 *  a própria API) está gerando um id novo em vez de propagar o recebido. */
export function checkRequestIdEcho(res, sentRequestId, rotulo) {
  return check(res, {
    [`${rotulo}: X-Request-Id ecoado`]: (r) =>
      r.headers["X-Request-Id"] === sentRequestId,
  });
}

function isIncidentDtoShapeValid(item) {
  return (
    item !== null &&
    typeof item === "object" &&
    typeof item.id === "string" &&
    VALID_PRIORITIES.has(item.priority) &&
    typeof item.startedAt === "string" &&
    !Number.isNaN(Date.parse(item.startedAt)) &&
    Array.isArray(item.scopeSummary) &&
    item.impact !== null &&
    typeof item.impact === "object"
  );
}

/** Forma mínima de cada item de `data.items` em GET /api/v1/incidents —
 *  não é uma revalidação do Zod (ver cabeçalho do arquivo), só os campos
 *  que os cenários de carga dependem: id, priority, startedAt, scopeSummary
 *  e impact presentes e com o tipo esperado. */
export function checkIncidentsSchema(res, rotulo) {
  return check(res, {
    [`${rotulo}: schema de items`]: (r) => {
      if (r.status !== 200) return true;
      try {
        const items = r.json("data.items");
        return Array.isArray(items) && items.every(isIncidentDtoShapeValid);
      } catch {
        return false;
      }
    },
  });
}

const GATEWAY_META_KEYS = [
  "requestId",
  "schemaVersion",
  "datasetVersion",
  "generatedAt",
  "window",
  "partial",
  "refreshAfterSeconds",
  "freshness",
  "warnings",
];
const DATASET_VERSION_PATTERN = /^dsv_[0-9a-f]{64}$/;

/** Corpo JSON ou `null` quando o corpo não é JSON válido. */
export function parseBody(res) {
  try {
    return res.json();
  } catch {
    return null;
  }
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((k) => keys.includes(k));
}

/** Versão enxuta de `isGatewayEnvelope()` de
 *  apps/frontend/lib/data/client.ts. O frontend trata como "resposta fora do
 *  contrato" (e mostra o bloco como indisponível) qualquer 200 cujo `meta`
 *  não tenha exatamente estas chaves — então um 200 sem envelope válido é, para
 *  o usuário, uma falha, mesmo que o k6 visse "status 200". */
export function isGatewayEnvelope(body) {
  if (body === null || typeof body !== "object" || !("data" in body))
    return false;
  const meta = body.meta;
  return (
    meta !== null &&
    typeof meta === "object" &&
    !Array.isArray(meta) &&
    hasExactKeys(meta, GATEWAY_META_KEYS) &&
    typeof meta.requestId === "string" &&
    meta.requestId.length > 0 &&
    meta.schemaVersion === "1.0" &&
    (meta.datasetVersion === null ||
      DATASET_VERSION_PATTERN.test(meta.datasetVersion)) &&
    typeof meta.generatedAt === "string" &&
    !Number.isNaN(Date.parse(meta.generatedAt)) &&
    (meta.window === null || typeof meta.window === "object") &&
    typeof meta.partial === "boolean" &&
    (meta.refreshAfterSeconds === null ||
      (Number.isSafeInteger(meta.refreshAfterSeconds) &&
        meta.refreshAfterSeconds > 0)) &&
    Array.isArray(meta.freshness) &&
    Array.isArray(meta.warnings)
  );
}

/** O 200 traz o envelope `{data, meta}` que o frontend exige. */
export function checkGatewayEnvelope(res, rotulo, body = parseBody(res)) {
  return check(res, {
    [`${rotulo}: envelope do gateway`]: (r) =>
      r.status !== 200 || isGatewayEnvelope(body),
  });
}

/** Sem duplicidade de id entre duas páginas obtidas com o mesmo cursor —
 *  o cenário G (paginação) é o único que exercita isso de ponta a ponta. */
export function checkNoDuplicateIds(firstItems, secondItems, rotulo) {
  const firstIds = new Set(firstItems.map((item) => item.id));
  const noOverlap = !secondItems.some((item) => firstIds.has(item.id));
  return check(noOverlap, {
    [`${rotulo}: sem duplicidade entre páginas`]: (ok) => ok,
  });
}
