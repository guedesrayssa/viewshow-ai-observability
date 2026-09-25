import { ServiceError, createLogger, type Logger } from "@view-show/contracts";
import { ActiveDatasetContractError } from "../domain/active-dataset.js";
import type {
  ActiveDatasetResolver,
  ActiveDatasetSnapshot,
} from "../ports/active-dataset-resolver.js";

const defaultLogger = createLogger("api");

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
  try {
    const active = await resolver.resolve();
    if (active) return active;
    logger.warn("active dataset pointer absent", { reason: "absent" });
  } catch (error) {
    logger.error("active dataset unavailable", {
      reason: error instanceof ActiveDatasetContractError ? "contract" : "io",
      error_name: error instanceof Error ? error.name : "unknown",
    });
  }
  throw new ServiceError(
    503,
    "DATA_UNAVAILABLE",
    "Nenhuma versão ativa e compatível do dataset está disponível.",
  );
}
