import type { ActiveDatasetSnapshot } from "../../datasets/ports/active-dataset-resolver.js";

export type PublicProjection = Readonly<Record<string, unknown>>;

export interface ProjectionRead {
  readonly data: PublicProjection;
  readonly observedThrough: string | null;
  readonly coverageRatio: number | null;
  readonly source: string;
}

export interface DashboardReadRepository {
  activeOverview(active: ActiveDatasetSnapshot): Promise<ProjectionRead | null>;
  latestMonitoring(
    active: ActiveDatasetSnapshot,
    from: Date,
    to: Date,
    sources: readonly string[],
  ): Promise<ProjectionRead | null>;
}
