import { DynamoIncidentRepository } from "./adapters/dynamodb-incident-repository.js";
import {
  IncidentUseCases,
  UnavailableReanalysisPublisherPort,
  UnavailableReviewFeedbackPort,
} from "./application/incident-use-cases.js";
import { loadConfig } from "./config.js";
import { CursorCodec } from "./domain/cursor.js";
import type { ActiveDatasetResolver } from "../datasets/index.js";
import { SqsReanalysisPublisher } from "./adapters/sqs-reanalysis-publisher.js";

export { IncidentUseCases } from "./application/incident-use-cases.js";

/** Builds the incidents module wired to DynamoDB for in-process use by the API. */
export function createIncidentsModule(
  environment: NodeJS.ProcessEnv,
  activeDataset: ActiveDatasetResolver,
): IncidentUseCases {
  const config = loadConfig(environment);
  const repository = new DynamoIncidentRepository(
    config.region,
    config.tableName,
    undefined,
    config.endpoint,
  );
  return new IncidentUseCases(
    repository,
    activeDataset,
    new CursorCodec(config.cursorSecret),
    new UnavailableReviewFeedbackPort(),
    undefined,
    config.analysisQueueUrl
      ? new SqsReanalysisPublisher(config.analysisQueueUrl, config.region)
      : new UnavailableReanalysisPublisherPort(),
  );
}
