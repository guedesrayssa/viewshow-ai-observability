/**
 * @file vitest.setup.ts
 * Preparação comum dos testes de componente.
 *
 * jsdom não implementa `matchMedia` nem os observadores que os cartões do
 * painel usam para se medir e animar a entrada. Sem estes stubs, o primeiro
 * render derruba a árvore: `useMediaQuery` chama `window.matchMedia`, e um
 * `useEffect` instancia `ResizeObserver`.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
});

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

vi.stubGlobal("ResizeObserver", NoopObserver);
vi.stubGlobal("IntersectionObserver", NoopObserver);

vi.stubGlobal("matchMedia", (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
}));
