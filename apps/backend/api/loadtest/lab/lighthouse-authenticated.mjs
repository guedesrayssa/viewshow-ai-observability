// Sequential performance audits of authenticated deployed pages, with a synthetic session.
// Cognito login is deliberately outside this experiment. Session bytes are never saved.
import { spawnSync } from "node:child_process";
import { createHmac, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const dir = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(dir, "../../../../frontend");
const require = createRequire(path.join(frontend, "package.json"));
const { default: lighthouse } = await import(require.resolve("lighthouse"));
const { launch } = await import(require.resolve("chrome-launcher"));
const { default: desktop } = await import(
  require.resolve("lighthouse/core/config/desktop-config.js")
);
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
const definition = aws([
  "ecs",
  "describe-task-definition",
  "--task-definition",
  "view-show-iac-api-task:1",
]).taskDefinition;
const secret = definition.containerDefinitions
  .find((c) => c.name === "view-show-iac-api")
  .environment.find((e) => e.name === "AUTH_COOKIE_SECRET").value;
const now = Math.floor(Date.now() / 1000);
const encoded = Buffer.from(
  JSON.stringify({
    id: "k6-load-test",
    email: "k6-load-test@globoplay.com",
    name: "Operador sintético RNF",
    role: "engineer",
    issuedAt: now,
    expiresAt: now + 7200,
    sessionId: "rnf-lighthouse-" + now,
  }),
).toString("base64url");
const cookie =
  encoded +
  "." +
  createHmac("sha256", secret).update(encoded).digest("base64url");
const out = path.resolve(process.env.RESULTS_DIR);
await mkdir(out, { recursive: true });
const base = process.env.PANEL_URL;
if (new URL(base).hostname !== "producao.d1svpthoa1rnkp.amplifyapp.com")
  throw Error("Unexpected authenticated target");
const runs = [];
for (const route of (
  process.env.LIGHTHOUSE_ROUTES || "visao-geral,incidentes,monitoramento"
).split(",")) {
  for (const profile of ["desktop", "mobile"]) {
    for (let repetition = 1; repetition <= 3; repetition++) {
      const startedAt = new Date().toISOString();
      const chrome = await launch({
        chromePath: process.env.CHROME_PATH,
        chromeFlags: ["--headless=new"],
        logLevel: "silent",
      });
      let result;
      try {
        result = await lighthouse(
          `${base}/${route}/`,
          {
            port: chrome.port,
            onlyCategories: ["performance"],
            output: "json",
            logLevel: "error",
            extraHeaders: { Cookie: "session=" + cookie },
          },
          profile === "desktop" ? desktop : undefined,
        );
      } finally {
        await chrome.kill();
      }
      const report = result.lhr;
      const metrics = Object.fromEntries(
        [
          "first-contentful-paint",
          "largest-contentful-paint",
          "total-blocking-time",
          "cumulative-layout-shift",
        ].map((name) => [name, report.audits[name]?.numericValue]),
      );
      if (
        Object.values(metrics).some((value) => !Number.isFinite(value)) ||
        report.runtimeError
      )
        throw Error(`Invalid Lighthouse metrics ${route}/${profile}`);
      if (new URL(report.finalDisplayedUrl).pathname.startsWith("/login"))
        throw Error(
          "Authentication failed; refusing to report login as an authenticated page",
        );
      const file = `${route}-${profile}-${repetition}.json`;
      const safe = JSON.stringify(report).replaceAll(
        cookie,
        "[REDACTED_SESSION]",
      );
      await writeFile(path.join(out, file), safe + "\n");
      const run = {
        route,
        profile,
        repetition,
        startedAt,
        finishedAt: new Date().toISOString(),
        file,
        sha256: createHash("sha256")
          .update(safe + "\n")
          .digest("hex"),
        metrics,
        finalUrl: report.finalDisplayedUrl,
        score: report.categories.performance.score,
        lighthouseVersion: report.lighthouseVersion,
        warnings: report.runWarnings,
      };
      runs.push(run);
      console.log(JSON.stringify(run));
      await writeFile(
        path.join(out, "executions.json"),
        JSON.stringify(
          {
            account,
            sequential: true,
            target: base,
            auth: "synthetic signed session; Cognito login excluded",
            apiImage: definition.containerDefinitions.find(
              (c) => c.name === "view-show-iac-api",
            ).image,
            runs,
          },
          null,
          2,
        ) + "\n",
      );
    }
  }
}
