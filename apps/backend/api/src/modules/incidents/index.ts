import { DynamoIncidentRepository } from "./adapters/dynamodb-incident-repository.js";
import {
  IncidentUseCases,
  UnavailableReviewFeedbackPort,
} from "./application/incident-use-cases.js";
import { loadConfig } from "./config.js";
import { CursorCodec } from "./domain/cursor.js";

export { IncidentUseCases } from "./application/incident-use-cases.js";

/** Builds the incidents module wired to DynamoDB for in-process use by the API. */
export function createIncidentsModule(
  environment: NodeJS.ProcessEnv = process.env,
): IncidentUseCases {
  const config = loadConfig(environment);
  const repository = new DynamoIncidentRepository(
    config.region,
    config.tableName,
  );
  return new IncidentUseCases(
    repository,
    new CursorCodec(config.cursorSecret),
    new UnavailableReviewFeedbackPort(),
  );
}
