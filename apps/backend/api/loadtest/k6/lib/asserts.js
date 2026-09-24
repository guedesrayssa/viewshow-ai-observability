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

/** Sem duplicidade de id entre duas páginas obtidas com o mesmo cursor —
 *  o cenário G (paginação) é o único que exercita isso de ponta a ponta. */
export function checkNoDuplicateIds(firstItems, secondItems, rotulo) {
  const firstIds = new Set(firstItems.map((item) => item.id));
  const noOverlap = !secondItems.some((item) => firstIds.has(item.id));
  return check(noOverlap, {
    [`${rotulo}: sem duplicidade entre páginas`]: (ok) => ok,
  });
}
