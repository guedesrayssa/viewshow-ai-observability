import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { render } from "../render.mjs";
import { config } from "./fixtures.mjs";
import { withCleanup } from "../../scripts/lib/learner-lab-kubernetes-runtime.mjs";

// Type-checking runs asynchronously after create. An unbound temporary policy
// exercises that status without affecting admission of any workload.
test(
  "rendered admission policies compile against Kubernetes schema-typed CEL",
  {
    skip: process.env.RUN_LIVE_KUBERNETES_POLICY_TESTS !== "1",
  },
  async () => {
    let input = config;
    if (process.env.KUBERNETES_POLICY_CONFIG_SOURCE === "terraform") {
      const output = spawnSync(
        "terraform",
        [
          `-chdir=${fileURLToPath(new URL("../../fullstack", import.meta.url))}`,
          "output",
          "-json",
          "kubernetes_deployment",
        ],
        { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
      );
      // Terraform output may contain credentials; never reflect its contents.
      assert.equal(output.status, 0, "Terraform configuration read failed");
      input = JSON.parse(output.stdout);
    }
    const rendered = await render(input, async () => "test-password");
    for (const policy of rendered.resources.filter(
      (resource) => resource.kind === "ValidatingAdmissionPolicy",
    )) {
      const name = `cel-check-${randomUUID()}`;
      policy.metadata.name = name;
      await withCleanup(async () => {
        const result = spawnSync(
          "kubectl",
          ["create", "--request-timeout=30s", "-f", "-", "-o", "json"],
          { input: JSON.stringify(policy), encoding: "utf8" },
        );
        assert.equal(result.status, 0, `${name}: ${result.stderr}`);
        const deadline = Date.now() + 60_000;
        let validated;
        do {
          const observed = spawnSync(
            "kubectl",
            [
              "get",
              "validatingadmissionpolicy",
              name,
              "--request-timeout=15s",
              "-o",
              "json",
            ],
            { encoding: "utf8" },
          );
          assert.equal(observed.status, 0, `${name}: ${observed.stderr}`);
          validated = JSON.parse(observed.stdout);
          if (
            validated.status?.observedGeneration ===
            validated.metadata.generation
          )
            break;
          await setTimeout(1000);
        } while (Date.now() < deadline);
        assert.equal(
          validated.status?.observedGeneration,
          validated.metadata.generation,
          `${name}: API server did not finish type-checking`,
        );
        assert.deepEqual(
          validated.status?.typeChecking?.expressionWarnings ?? [],
          [],
          `${name} must type-check without warnings`,
        );
      }, async () => {
        const deleted = spawnSync(
          "kubectl",
          [
            "delete",
            "validatingadmissionpolicy",
            name,
            "--ignore-not-found",
            "--request-timeout=30s",
            "--wait=true",
          ],
          { encoding: "utf8" },
        );
        assert.equal(
          deleted.status,
          0,
          `Temporary policy cleanup failed: ${name}`,
        );
      });
    }
  },
);
