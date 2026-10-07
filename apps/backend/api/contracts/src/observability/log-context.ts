import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Campos que acompanham toda linha de log emitida durante uma requisição
 * (`request_id`, por exemplo), sem que cada camada precise recebê-los por
 * parâmetro. O contexto nasce no middleware HTTP e atravessa `await`.
 */
const storage = new AsyncLocalStorage<Record<string, unknown>>();

const EMPTY: Readonly<Record<string, unknown>> = Object.freeze({});

export function runWithLogContext<T>(
  fields: Readonly<Record<string, unknown>>,
  callback: () => T,
): T {
  return storage.run({ ...fields }, callback);
}

/** Acrescenta campos ao contexto corrente; sem contexto ativo, não faz nada. */
export function addLogContext(fields: Readonly<Record<string, unknown>>): void {
  const store = storage.getStore();
  if (store) Object.assign(store, fields);
}

export function getLogContext(): Readonly<Record<string, unknown>> {
  return storage.getStore() ?? EMPTY;
}
