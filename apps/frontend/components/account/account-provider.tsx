/**
 * @file account-provider.tsx
 * Perfil da pessoa que está usando a plataforma.
 *
 * Nome e foto podem ser alterados em Configurações e aparecem na navegação, na
 * barra superior e na autoria dos registros de hipótese. Como a alteração vale
 * para toda a interface, o perfil vive em um lugar só e é lido de lá.
 *
 * Identidade (e-mail, cargo, método de entrada, último acesso) vem da sessão
 * em `/auth/session` — quem logou de verdade pelo Cognito aparece aqui, não um
 * nome fixo. Só nome e foto têm sobreposição local, porque só esses dois têm
 * edição própria na tela de Configurações; o resto é o que o provedor de
 * identidade disse.
 */

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import {
  fetchSessionIdentity,
  isDemoModeActive,
  signOut as requestSignOut,
  type SessionIdentity,
  type SessionRole,
} from "@/lib/auth";
import type { AccountProfile } from "@/lib/settings-data";
import { createPersistedJson } from "@/lib/persisted-preference";

/** Campos que a pessoa usuária pode alterar. `null` = sem sobreposição local. */
export type EditableProfile = {
  name: string | null;
  /** Foto em data URL, ou `null` enquanto não houver uma. */
  photo: string | null;
};

const DEFAULT_EDITS: EditableProfile = { name: null, photo: null };

function revive(raw: unknown): EditableProfile | null {
  if (typeof raw !== "object" || raw === null) return null;

  const value = raw as Partial<EditableProfile>;
  const name =
    typeof value.name === "string" && value.name.trim()
      ? value.name.trim()
      : null;
  const photo = typeof value.photo === "string" ? value.photo : null;

  return { name, photo };
}

const accountStore = createPersistedJson<EditableProfile>(
  "view-show:account",
  DEFAULT_EDITS,
  revive,
);

const ROLE_LABELS: Record<SessionRole, string> = {
  admin: "Administrador(a)",
  engineer: "Engenheiro(a)",
  viewer: "Visualizador(a)",
};

const UNAVAILABLE_PROFILE: AccountProfile = {
  name: "Sem sessão",
  email: "—",
  role: "—",
  authMethod: "—",
  lastAccess: "—",
};

const DEMO_PROFILE: AccountProfile = {
  name: "Conta de demonstração",
  email: "demo@viewshow.exemplo",
  role: "Demonstração",
  authMethod: "Modo de demonstração",
  lastAccess: "Sem sessão real",
};

function formatIssuedAt(issuedAt: string): string {
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(issuedAt));
  } catch {
    return "—";
  }
}

function profileFromSession(session: SessionIdentity): AccountProfile {
  return {
    name: session.name ?? session.email,
    email: session.email,
    role: ROLE_LABELS[session.role],
    authMethod: "E-mail e senha (Cognito)",
    lastAccess: formatIssuedAt(session.issuedAt),
  };
}

/**
 * "checking" só dura até a primeira resposta de `/auth/session`; depois disso
 * é sempre "authenticated" ou "unauthenticated". Quem precisa decidir se
 * mostra ou esconde algo antes de saber a sessão (como `PanelGuard`) lê isto
 * em vez de repetir o fetch.
 */
export type SessionStatus = "checking" | "authenticated" | "unauthenticated";

type AccountContextValue = {
  /** Perfil completo, já com as alterações aplicadas. */
  profile: AccountProfile & { photo: string | null };
  sessionStatus: SessionStatus;
  updateProfile: (patch: Partial<EditableProfile>) => void;
  /** Remove o nome sobreposto e a foto; volta ao nome da sessão. */
  reset: () => void;
  /** Encerra a sessão no backend e limpa nome/foto sobrepostos localmente. */
  signOut: () => Promise<void>;
};

const AccountContext = createContext<AccountContextValue | null>(null);

export function AccountProvider({ children }: { children: ReactNode }) {
  const edits = useSyncExternalStore(
    accountStore.subscribe,
    accountStore.getSnapshot,
    accountStore.getServerSnapshot,
  );

  // `undefined` = ainda não voltou a primeira checagem; `null` = voltou e
  // confirmou que não há sessão. Os dois viram "sem identidade" para o
  // perfil (linha do `base` abaixo), mas só o segundo é "unauthenticated"
  // para quem faz guarda de rota.
  const [session, setSession] = useState<SessionIdentity | null | undefined>(
    undefined,
  );

  useEffect(() => {
    let cancelled = false;
    fetchSessionIdentity().then((identity) => {
      if (!cancelled) setSession(identity);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateProfile = useCallback((patch: Partial<EditableProfile>) => {
    accountStore.set({ ...accountStore.getSnapshot(), ...patch });
  }, []);

  const reset = useCallback(() => accountStore.set(DEFAULT_EDITS), []);

  const signOut = useCallback(async () => {
    await requestSignOut();
    accountStore.set(DEFAULT_EDITS);
    setSession(null);
  }, []);

  const sessionStatus: SessionStatus =
    session === undefined
      ? "checking"
      : session
        ? "authenticated"
        : "unauthenticated";

  const value = useMemo<AccountContextValue>(() => {
    const base = session
      ? profileFromSession(session)
      : isDemoModeActive()
        ? DEMO_PROFILE
        : UNAVAILABLE_PROFILE;

    return {
      profile: {
        ...base,
        name: edits.name ?? base.name,
        photo: edits.photo,
      },
      sessionStatus,
      updateProfile,
      reset,
      signOut,
    };
  }, [session, sessionStatus, edits, updateProfile, reset, signOut]);

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
