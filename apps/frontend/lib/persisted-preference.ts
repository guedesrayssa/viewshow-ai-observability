/**
 * @file persisted-preference.ts
 * Preferência da pessoa usuária guardada no navegador.
 *
 * Uma preferência é estado externo ao React: ela existe antes da aplicação
 * montar e sobrevive a ela. Modelá-la como uma pequena loja com assinatura
 * permite que os componentes a leiam com `useSyncExternalStore`, sem efeito de
 * correção depois da primeira pintura e sem duas telas discordando sobre o
 * valor em vigor.
 *
 * O armazenamento pode estar bloqueado (janela anônima, política corporativa).
 * Nesse caso a preferência continua funcionando, só não sobrevive ao
 * recarregamento.
 */

export type PersistedPreference<T> = {
  /** Assina mudanças. Devolve a função que cancela a assinatura. */
  subscribe: (onChange: () => void) => () => void;
  /** Valor em vigor no navegador. */
  getSnapshot: () => T;
  /** Valor usado na renderização do servidor. */
  getServerSnapshot: () => T;
  /** Grava o novo valor e avisa quem estiver assinando. */
  set: (value: T) => void;
};

/**
 * Cria uma preferência persistida em `localStorage`.
 *
 * @param key - Chave do armazenamento local.
 * @param fallback - Valor usado no servidor e quando nada válido foi salvo.
 * @param isValid - Confere se o texto lido é um valor aceito.
 *
 * @example
 * const theme = createPersistedPreference("view-show:theme", "system",
 *   (raw): raw is ThemePreference => raw === "light" || raw === "dark");
 */
export function createPersistedPreference<T extends string>(
  key: string,
  fallback: T,
  isValid: (raw: string) => raw is T,
): PersistedPreference<T> {
  const listeners = new Set<() => void>();

  // `useSyncExternalStore` exige que leituras seguidas devolvam o mesmo valor
  // enquanto nada mudou, então a leitura fica em cache até uma escrita.
  let cached: T | undefined;

  function read(): T {
    try {
      const raw = window.localStorage.getItem(key);
      return raw !== null && isValid(raw) ? raw : fallback;
    } catch {
      return fallback;
    }
  }

  function notify() {
    for (const listener of listeners) listener();
  }

  /* Mudança feita em outra aba do mesmo navegador. */
  function onStorage(event: StorageEvent) {
    if (event.key !== key) return;
    cached = undefined;
    notify();
  }

  return {
    subscribe(onChange) {
      listeners.add(onChange);
      window.addEventListener("storage", onStorage);

      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0) {
          window.removeEventListener("storage", onStorage);
        }
      };
    },

    getSnapshot() {
      if (cached === undefined) cached = read();
      return cached;
    },

    getServerSnapshot() {
      return fallback;
    },

    set(value) {
      cached = value;
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // Ver o comentário do topo: a preferência vale só para esta sessão.
      }
      notify();
    },
  };
}

/**
 * Cria um valor estruturado persistido em `localStorage`.
 *
 * Mesma ideia de `createPersistedPreference`, para dados que não cabem em uma
 * palavra — como o perfil da conta, que tem nome e foto.
 *
 * @param key - Chave do armazenamento local.
 * @param fallback - Valor usado no servidor e quando nada válido foi salvo.
 * @param revive - Converte o objeto lido no formato esperado, ou devolve
 * `null` quando o conteúdo salvo não serve mais.
 *
 * @example
 * const account = createPersistedJson("view-show:account", DEFAULT, reviveAccount);
 */
export function createPersistedJson<T>(
  key: string,
  fallback: T,
  revive: (raw: unknown) => T | null,
): PersistedPreference<T> {
  const listeners = new Set<() => void>();
  let cached: T | undefined;

  function read(): T {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return fallback;
      return revive(JSON.parse(raw)) ?? fallback;
    } catch {
      return fallback;
    }
  }

  function notify() {
    for (const listener of listeners) listener();
  }

  function onStorage(event: StorageEvent) {
    if (event.key !== key) return;
    cached = undefined;
    notify();
  }

  return {
    subscribe(onChange) {
      listeners.add(onChange);
      window.addEventListener("storage", onStorage);

      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0) {
          window.removeEventListener("storage", onStorage);
        }
      };
    },

    getSnapshot() {
      if (cached === undefined) cached = read();
      return cached;
    },

    getServerSnapshot() {
      return fallback;
    },

    set(value) {
      cached = value;
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch {
        // Armazenamento cheio ou bloqueado: o valor vale para esta sessão.
      }
      notify();
    },
  };
}
