import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

async function runtimeSources(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory() && !["node_modules", ".next", "out", "tests", "docs"].includes(entry.name)) return [runtimeSources(path)];
    if (
      entry.isFile() &&
      [".ts", ".tsx"].includes(extname(entry.name)) &&
      !/\.(test|spec)\.[jt]sx?$/.test(entry.name) &&
      !/^vitest\.(config|setup)\./.test(entry.name)
    )
      return [readFile(path, "utf8").then((value) => [value])];
    return [];
  }));
  return nested.flat();
}

describe("runtime migration", () => {
  it("has no dependency on the retired Flask MVP", async () => {
    // O runner de testes roda a partir de apps/frontend; import.meta.url não é
    // um file: URL confiável sob jsdom, então varremos a raiz do app pelo cwd.
    const source = (await runtimeSources(process.cwd())).join("\n");
    expect(source).not.toContain("apps/basica");
    expect(source).not.toContain("NEXT_PUBLIC_TELEMETRY_API_BASE_URL");
    expect(source).not.toContain("/v1/analytics/");
  });
});
