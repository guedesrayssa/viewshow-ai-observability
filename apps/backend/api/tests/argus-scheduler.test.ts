import { describe, expect, it, vi } from "vitest";
import { KubernetesArgusScheduler } from "../src/modules/argus/adapters/kubernetes-argus-scheduler.ts";
describe("ARGUS CronJob control", () => {
  it.each([true, false])(
    "sets enabled=%s without rewriting the template",
    async (enabled) => {
      const request = vi.fn().mockResolvedValue({});
      await new KubernetesArgusScheduler("view-show", "ingestion-sync", {
        request,
      }).setEnabled(enabled);
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "PATCH",
        "/apis/batch/v1/namespaces/view-show/cronjobs/ingestion-sync",
        { spec: { suspend: !enabled } },
      );
    },
  );
  it("propagates failed patches to the compensating use case", async () => {
    const request = vi.fn().mockRejectedValue(new Error("unavailable"));
    await expect(
      new KubernetesArgusScheduler("view-show", "ingestion-sync", {
        request,
      }).setEnabled(true),
    ).rejects.toThrow("unavailable");
  });
});
