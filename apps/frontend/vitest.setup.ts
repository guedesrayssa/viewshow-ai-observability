/**
 * @file vitest.setup.ts
 * Preparação comum dos testes de componente.
 *
 * jsdom não implementa `matchMedia` nem os observadores que os cartões do
 * painel usam para se medir e animar a entrada. Também não oferece
 * `scrollIntoView`, usado pelo seletor para manter a opção ativa visível.
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

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  writable: true,
  value: NoopObserver,
});
Object.defineProperty(globalThis, "IntersectionObserver", {
  configurable: true,
  writable: true,
  value: NoopObserver,
});

HTMLElement.prototype.scrollIntoView = vi.fn();

Object.defineProperty(globalThis, "matchMedia", {
  configurable: true,
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
