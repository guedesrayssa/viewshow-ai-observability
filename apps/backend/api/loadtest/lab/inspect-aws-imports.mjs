import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
function aws(args) {
  const r = spawnSync(
    "aws",
    [...args, "--region", "us-east-1", "--output", "json"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw Error("AWS read failed");
  return JSON.parse(r.stdout);
}
const account = aws(["sts", "get-caller-identity"]).Account;
if (account !== process.env.EXPECTED_AWS_ACCOUNT_ID)
  throw Error("AWS account mismatch");
const def = aws([
  "ecs",
  "describe-task-definition",
  "--task-definition",
  "view-show-iac-api-task:1",
]).taskDefinition;
const env = def.containerDefinitions.find(
  (c) => c.name === "view-show-iac-api",
).environment;
const secret = env.find((e) => e.name === "AUTH_COOKIE_SECRET").value;
const now = Math.floor(Date.now() / 1000);
const encoded = Buffer.from(
  JSON.stringify({
    id: "k6-load-test",
    email: "k6-load-test@globoplay.com",
    name: null,
    role: "engineer",
    issuedAt: now,
    expiresAt: now + 3600,
    sessionId: "k6-monitor-" + now,
  }),
).toString("base64url");
const cookie =
  encoded +
  "." +
  createHmac("sha256", secret).update(encoded).digest("base64url");
const response = await fetch(process.env.BASE_URL + "/api/v1/imports", {
  headers: { Cookie: "session=" + cookie },
});
if (!response.ok) throw Error("Import inspection HTTP " + response.status);
const d = await response.json();
const items = Array.isArray(d.data)
  ? d.data
  : d.data.items || d.data.imports || [];
console.log(
  JSON.stringify(
    items.map((x) => ({
      importId: x.importId,
      state: x.state,
      errorCode: x.error?.code,
      updatedAt: x.updatedAt,
      phase: x.progress?.stage,
      runId: x.runId,
      recordsRead: x.progress?.recordsRead,
      recordsWritten: x.progress?.recordsWritten,
      recordsRejected: x.progress?.recordsRejected,
      candidateVersion: x.candidateVersion,
      createdAt: x.createdAt,
      finishedAt: x.finishedAt,
    })),
    null,
    2,
  ),
);
