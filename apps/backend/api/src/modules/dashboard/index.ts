import { DynamoDashboardReadRepository } from "./adapters/dynamodb-dashboard-read-repository.js";
import { DashboardQueries } from "./application/dashboard-queries.js";
import { loadConfig } from "./config.js";

export { DashboardQueries } from "./application/dashboard-queries.js";

/** Builds the dashboard read module wired to DynamoDB for in-process use by the API. */
export function createDashboardModule(
  environment: NodeJS.ProcessEnv = process.env,
): DashboardQueries {
  const config = loadConfig(environment);
  return new DashboardQueries(
    new DynamoDashboardReadRepository(
      config.region,
      config.tableName,
      undefined,
      config.endpoint,
    ),
    config.monitoringSources,
  );
}
