import {
  ServiceError,
  annotateActiveSpan,
  createLogThrottle,
  createLogger,
  serializeError,
  type Logger,
} from "@view-show/contracts";
import { ActiveDatasetContractError } from "../domain/active-dataset.js";
import type {
  ActiveDatasetResolver,
  ActiveDatasetSnapshot,
} from "../ports/active-dataset-resolver.js";

const defaultLogger = createLogger("view-show-api");

// Com o ponteiro ausente ou ilegível, TODA leitura da API chega aqui. Sem limite,
// uma indisponibilidade do dataset gera uma linha de log por requisição.
const throttles = new WeakMap<Logger, ReturnType<typeof createLogThrottle>>();
function throttleFor(logger: Logger): ReturnType<typeof createLogThrottle> {
  let throttle = throttles.get(logger);
  if (!throttle) {
    throttle = createLogThrottle();
    throttles.set(logger, throttle);
  }
  return throttle;
}

// A borda pública não distingue ponteiro ACTIVE ausente, malformado ou
// temporariamente ilegível: as três causas devolvem a mesma recusa, para não
// vazar estado interno. Indistinguível para o cliente não pode significar
// indistinguível para quem opera — sem este registro, "a ingestão ainda não
// ativou" e "a role da task perdeu dynamodb:GetItem" produzem o mesmo 503 e a
// equipe espera por um backfill que já terminou.
export async function requireActiveDataset(
  resolver: ActiveDatasetResolver,
  logger: Logger = defaultLogger,
): Promise<ActiveDatasetSnapshot> {
  const throttle = throttleFor(logger);
  try {
    const active = await resolver.resolve();
    if (active) {
      // Qual versão do dataset serviu esta requisição, visível no trace.
      annotateActiveSpan({ "viewshow.dataset_version": active.datasetVersion });
      return active;
    }
    const gate = throttle("absent");
    if (gate.emit)
      logger.warn("active dataset pointer absent", {
        event: "dataset.active.absent",
        reason: "absent",
        suppressed_count: gate.suppressed,
      });
  } catch (error) {
    const reason =
      error instanceof ActiveDatasetContractError ? "contract" : "io";
    const gate = throttle(reason);
    if (gate.emit)
      logger.error("active dataset unavailable", {
        event: "dataset.active.unavailable",
        reason,
        error_name: error instanceof Error ? error.name : "unknown",
        error: serializeError(error),
        suppressed_count: gate.suppressed,
      });
  }
  throw new ServiceError(
    503,
    "DATA_UNAVAILABLE",
    "Nenhuma versão ativa e compatível do dataset está disponível.",
  );
}
