export type PublicProjection = Readonly<Record<string, unknown>>;

export interface ProjectionRead {
  readonly data: PublicProjection;
  readonly observedThrough: string | null;
  readonly coverageRatio: number | null;
  readonly source: string;
}

export interface DashboardReadRepository {
  latestOverview(from: Date, to: Date): Promise<ProjectionRead | null>;
  latestMonitoring(
    from: Date,
    to: Date,
    sources: readonly string[],
  ): Promise<ProjectionRead | null>;
}
