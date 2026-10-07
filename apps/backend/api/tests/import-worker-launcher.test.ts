import { describe, expect, it, vi } from "vitest";
import { KubernetesImportWorkerLauncher } from "../src/modules/imports/adapters/kubernetes-import-worker-launcher.ts";
import { KubernetesApiError } from "../src/platform/kubernetes-client.ts";
const id = "imp_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const name = `import-${id.slice(4).toLowerCase()}`;
const uid = "01234567-89ab-cdef-0123-456789abcdef";
const config = {
  namespace: "view-show-imports",
  templateName: "ingestion-import",
  containerName: "ingestion",
};
const spec = {
  template: {
    spec: {
      serviceAccountName: "ingestion-import",
      containers: [
        {
          name: "ingestion",
          args: ["import-dump"],
          env: [{ name: "AWS_REGION", value: "us-east-1" }],
        },
      ],
      initContainers: [{ name: "mysql-snapshot", restartPolicy: "Always" }],
    },
  },
  backoffLimit: 0,
};
function job(status = {}) {
  return {
    metadata: {
      name,
      namespace: config.namespace,
      uid,
      labels: {
        "app.kubernetes.io/name": "ingestion-import",
        "view-show/import-id": id,
        "view-show/pipeline": "canonical-v2",
      },
    },
    spec: structuredClone(spec),
    status,
  };
}
const reference = `k8s://${config.namespace}/jobs/${name}/${uid}`;
describe("Kubernetes import jobs", () => {
  it("copies the trusted template and overrides only import arguments and identity", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ spec: { jobTemplate: { spec } } })
      .mockResolvedValueOnce(job());
    const launcher = new KubernetesImportWorkerLauncher(config, { request });
    expect(await launcher.launch(id, "canonical-v2")).toEqual({
      taskArn: reference,
    });
    const input = request.mock.calls[1]![2];
    expect(input.spec.template.spec.containers[0]).toMatchObject({
      args: ["import-dump", "--import-id", id],
      env: [
        { name: "AWS_REGION", value: "us-east-1" },
        { name: "IMPORT_ID", value: id },
        { name: "IMPORT_PIPELINE_VERSION", value: "canonical-v2" },
      ],
    });
    expect(input.spec.template.spec.initContainers).toEqual(
      spec.template.spec.initContainers,
    );
    expect(spec.template.spec.containers[0]!.args).toEqual(["import-dump"]);
  });
  it("reuses the same Job after a lost launch response", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ spec: { jobTemplate: { spec } } })
      .mockRejectedValueOnce(new KubernetesApiError(409))
      .mockResolvedValueOnce(job());
    expect(
      await new KubernetesImportWorkerLauncher(config, { request }).launch(
        id,
        "canonical-v2",
      ),
    ).toEqual({ taskArn: reference });
  });
  it("rejects a conflicting job belonging to another import pipeline", async () => {
    const existing = job();
    existing.metadata.labels["view-show/pipeline"] = "legacy-v1";
    const request = vi
      .fn()
      .mockResolvedValueOnce({ spec: { jobTemplate: { spec } } })
      .mockRejectedValueOnce(new KubernetesApiError(409))
      .mockResolvedValueOnce(existing);
    await expect(
      new KubernetesImportWorkerLauncher(config, { request }).launch(
        id,
        "canonical-v2",
      ),
    ).rejects.toThrow("evidence");
  });
  it.each([
    [{}, "PENDING", undefined],
    [{ active: 1 }, "RUNNING", undefined],
    [{ conditions: [{ type: "Complete", status: "True" }] }, "STOPPED", 0],
    [{ conditions: [{ type: "Failed", status: "True" }] }, "STOPPED", 1],
  ])("maps Kubernetes state %j", async (status, state, exitCode) => {
    const launcher = new KubernetesImportWorkerLauncher(config, {
      request: vi.fn().mockResolvedValue(job(status)),
    });
    expect(await launcher.status(reference)).toEqual({
      state,
      ...(exitCode === undefined ? {} : { exitCode }),
    });
  });
  it("recognizes a deleted job while propagating authentication failures", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new KubernetesApiError(404))
      .mockRejectedValueOnce(new KubernetesApiError(403));
    const launcher = new KubernetesImportWorkerLauncher(config, { request });
    expect(await launcher.status(reference)).toEqual({ state: "STOPPED" });
    await expect(launcher.status(reference)).rejects.toThrow("403");
  });
  it("rejects namespace mismatch and replacement Jobs", async () => {
    const existing = job();
    existing.metadata.uid = "11234567-89ab-cdef-0123-456789abcdef";
    const request = vi.fn().mockResolvedValue(existing);
    const launcher = new KubernetesImportWorkerLauncher(config, { request });
    await expect(
      launcher.status(reference.replace("view-show-imports", "other")),
    ).rejects.toThrow("reference");
    expect(request).not.toHaveBeenCalled();
    await expect(launcher.status(reference)).rejects.toThrow("UID");
  });
});
