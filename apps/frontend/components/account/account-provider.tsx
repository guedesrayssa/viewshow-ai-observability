/**
 * @file account-provider.tsx
 * Perfil da pessoa que está usando a plataforma.
 *
 * Nome e foto podem ser alterados em Configurações e aparecem na navegação, na
 * barra superior e na autoria dos registros de hipótese. Como a alteração vale
 * para toda a interface, o perfil vive em um lugar só e é lido de lá.
 *
 * Enquanto a API de conta não existe, a alteração fica guardada no navegador.
 * Quando existir, `updateProfile` passa a enviar a mudança e o resto da
 * interface continua igual.
 */

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { ACCOUNT_PROFILE, type AccountProfile } from "@/lib/settings-data";
import { createPersistedJson } from "@/lib/persisted-preference";

/** Campos que a pessoa usuária pode alterar. */
export type EditableProfile = {
  name: string;
  /** Foto em data URL, ou `null` enquanto não houver uma. */
  photo: string | null;
};

const DEFAULT_EDITS: EditableProfile = {
  name: ACCOUNT_PROFILE.name,
  photo: null,
};

function revive(raw: unknown): EditableProfile | null {
  if (typeof raw !== "object" || raw === null) return null;

  const value = raw as Partial<EditableProfile>;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const photo = typeof value.photo === "string" ? value.photo : null;

  if (!name) return null;
  return { name, photo };
}

const accountStore = createPersistedJson<EditableProfile>(
  "view-show:account",
  DEFAULT_EDITS,
  revive,
);

type AccountContextValue = {
  /** Perfil completo, já com as alterações aplicadas. */
  profile: AccountProfile & { photo: string | null };
  updateProfile: (patch: Partial<EditableProfile>) => void;
  /** Volta ao nome do provedor de identidade e remove a foto. */
  reset: () => void;
};

const AccountContext = createContext<AccountContextValue | null>(null);

export function AccountProvider({ children }: { children: ReactNode }) {
  const edits = useSyncExternalStore(
    accountStore.subscribe,
    accountStore.getSnapshot,
    accountStore.getServerSnapshot,
  );

  const updateProfile = useCallback((patch: Partial<EditableProfile>) => {
    accountStore.set({ ...accountStore.getSnapshot(), ...patch });
  }, []);

  const reset = useCallback(() => accountStore.set(DEFAULT_EDITS), []);

  const value = useMemo<AccountContextValue>(
    () => ({
      profile: { ...ACCOUNT_PROFILE, name: edits.name, photo: edits.photo },
      updateProfile,
      reset,
    }),
    [edits, updateProfile, reset],
  );

  return (
    <AccountContext.Provider value={value}>{children}</AccountContext.Provider>
  );
}

/**
 * Lê e altera o perfil da conta.
 *
 * @example
 * const { profile, updateProfile } = useAccount();
 */
export function useAccount(): AccountContextValue {
  const context = useContext(AccountContext);

  if (!context) {
    throw new Error("useAccount precisa estar dentro de <AccountProvider>.");
  }

  return context;
}
