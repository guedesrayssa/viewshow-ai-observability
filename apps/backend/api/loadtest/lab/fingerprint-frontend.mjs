// Identify exactly the deployed code resources observed in the authenticated audits.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
const dir = path.resolve(process.argv[2]);
const execution = JSON.parse(
  await readFile(path.join(dir, "executions.json"), "utf8"),
);
const urls = new Set();
for (const run of execution.runs) {
  const r = JSON.parse(await readFile(path.join(dir, run.file), "utf8"));
  for (const request of r.audits["network-requests"].details.items) {
    if (
      request.url.startsWith(execution.target + "/_next/static/") &&
      /\.(js|css)(\?|$)/.test(request.url)
    )
      urls.add(request.url);
  }
}
const resources = [];
for (const url of [...urls].sort()) {
  const response = await fetch(url);
  const type = response.headers.get("content-type");
  if (!response.ok || !/javascript|css/.test(type || ""))
    throw Error("Invalid static resource " + url);
  const bytes = Buffer.from(await response.arrayBuffer());
  resources.push({
    url,
    bytes: bytes.length,
    contentType: type,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    etag: response.headers.get("etag"),
  });
}
const fingerprint = createHash("sha256")
  .update(resources.map((r) => r.url + " " + r.sha256).join("\n"))
  .digest("hex");
await writeFile(
  path.join(dir, "deployed-assets-fingerprint.json"),
  JSON.stringify(
    {
      collectedAt: new Date().toISOString(),
      fingerprint,
      resources,
      scope:
        "resources observed across the 18 authenticated Lighthouse runs; identifies served bytes, not a Git revision",
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify({ resources: resources.length, fingerprint }));
