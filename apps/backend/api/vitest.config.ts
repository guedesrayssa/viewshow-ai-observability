import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/ci/**"],
    pool: "forks",
    maxWorkers: 4,
  },
});
