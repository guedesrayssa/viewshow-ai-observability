import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

const roots = ["src", "contracts/src"];
const violations = [];

async function inspect(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const candidate = join(path, entry.name);
    if (entry.isDirectory()) await inspect(candidate);
    else if (extname(entry.name) === ".ts") {
      const source = await readFile(candidate, "utf8");
      if (/\bany\b/.test(source)) violations.push(`${candidate}: explicit any is forbidden`);
      if (/console\.(log|warn|error)\(/.test(source)) violations.push(`${candidate}: use the structured logger`);
      if (/\bScan(Command)?\b/.test(source)) violations.push(`${candidate}: DynamoDB Scan is forbidden in request paths`);
    }
  }
}

for (const root of roots) await inspect(root);
if (violations.length) {
  process.stderr.write(`${violations.join("\n")}\n`);
  process.exitCode = 1;
}
