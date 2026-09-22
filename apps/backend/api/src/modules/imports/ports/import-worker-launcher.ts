import type { ImportPipelineVersion } from "../domain/import.js";

export interface ImportWorkerLauncher {
  launch(
    importId: string,
    pipelineVersion: ImportPipelineVersion,
  ): Promise<{ taskArn: string }>;
  status(taskArn: string): Promise<{
    state: "PENDING" | "RUNNING" | "STOPPED";
    exitCode?: number;
  }>;
}
