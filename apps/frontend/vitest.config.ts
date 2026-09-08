/**
 * @file vitest.config.ts
 * Testes unitários do painel.
 *
 * O CI compila e faz lint, mas a lógica de decisão das telas — quando um bloco
 * mostra dado, espaço reservado ou indisponível, e o que o cabeçalho declara
 * quando as duas leituras discordam — não era exercitada por nada. Estes testes
 * cobrem essa camada, em jsdom, sem subir backend.
 *
 * `@/` resolve para a raiz do app, como no `tsconfig.json`.
 */

import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", ".next/**", "out/**"],
  },
});
