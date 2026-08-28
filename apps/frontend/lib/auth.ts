/**
 * @file auth.ts
 * Regras de acesso do View Show.
 *
 * A autenticação é delegada ao serviço de identidade (RIE01, RESTR01): a
 * aplicação não guarda senha nem implementa validação própria de credencial.
 * As funções abaixo cobrem a validação de formulário no navegador e o envio
 * das credenciais ao provedor.
 *
 * A entrada aceita qualquer e-mail válido. A conta corporativa continua sendo
 * o caminho recomendado, e tem botão próprio no formulário, mas equipes
 * parceiras e ambientes de demonstração precisam entrar sem depender do SSO
 * da Globo.
 */

/** Domínios corporativos, usados no exemplo de preenchimento e no SSO. */
export const CORPORATE_DOMAINS = ["globo.com"] as const;

/** Endereço da API que intermedia a conversa com o provedor de identidade. */
const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

/** Formato mínimo de e-mail: algo, arroba, domínio com ponto e sem espaços. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type Credentials = {
  email: string;
  password: string;
};

export type SignInResult =
  /** `demo` indica sessão sem provedor de identidade por trás. */
  | { ok: true; demo?: boolean }
  | { ok: false; message: string };

export type SignUpData = {
  name: string;
  email: string;
  password: string;
};

export type SignUpResult =
  | { ok: true; name: string }
  | { ok: false; message: string; field?: "name" | "email" | "password" };

/** Tamanho mínimo de senha aceito pelo registro. */
export const MIN_PASSWORD_LENGTH = 8;

/** Aviso exibido quando o SSO corporativo não está configurado no ambiente. */
export const AUTH_UNAVAILABLE_MESSAGE =
  "A entrada por SSO Globo ainda não está disponível neste ambiente. Use e-mail e senha.";

/**
 * Verifica se o e-mail pertence a um domínio corporativo da Globo.
 *
 * Não restringe a entrada: serve para a interface reconhecer a conta
 * corporativa e sugerir o caminho do SSO, que é mais rápido e não pede senha.
 *
 * @param email - Endereço informado no formulário.
 * @returns `true` quando o domínio está na lista de domínios corporativos.
 *
 * @example
 * isCorporateEmail("giovana.matsu@globo.com"); // true
 */
export function isCorporateEmail(email: string): boolean {
  const domain = email.trim().toLowerCase().split("@")[1];
  if (!domain) return false;
  return CORPORATE_DOMAINS.some((allowed) => domain === allowed);
}

/**
 * Valida o campo de e-mail do formulário de acesso.
 *
 * @param email - Valor digitado.
 * @returns Mensagem de erro, ou `undefined` quando o valor é aceitável.
 */
export function validateEmail(email: string): string | undefined {
  const value = email.trim();

  if (!value) return "Informe o seu e-mail corporativo.";
  if (!EMAIL_PATTERN.test(value)) return "Digite um e-mail válido.";
  return undefined;
}

/**
 * Valida o campo de senha do formulário de acesso.
 *
 * A verificação aqui é apenas de preenchimento: a força e a expiração da senha
 * são responsabilidade do provedor corporativo.
 *
 * @param password - Valor digitado.
 * @returns Mensagem de erro, ou `undefined` quando o valor é aceitável.
 */
export function validatePassword(password: string): string | undefined {
  if (!password) return "Informe a sua senha.";
  return undefined;
}

/**
 * Envia as credenciais ao provedor de identidade.
 *
 * Sem endpoint de autenticação publicado, a entrada abre uma sessão de
 * demonstração: o painel inteiro funciona com o conjunto de exemplo, e travar
 * o acesso deixaria a plataforma inalcançável em um ambiente que ainda não tem
 * backend. A sessão é marcada como `demo` para que a interface possa dizê-lo.
 * Nada é persistido no navegador por esta camada.
 *
 * @param credentials - E-mail e senha informados.
 * @returns Resultado da tentativa de acesso.
 */
export async function signIn({
  email,
  password,
}: Credentials): Promise<SignInResult> {
  if (!API_BASE_URL) {
    return { ok: true, demo: true };
  }

  try {
    const response = await fetch(`${API_BASE_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // A sessão volta como cookie assinado pelo provedor: o token não passa
      // por `localStorage`, que fica exposto a scripts de terceiros.
      credentials: "include",
      body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
    });

    if (response.ok) return { ok: true };

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        message: "E-mail ou senha incorretos. Verifique e tente novamente.",
      };
    }

    return {
      ok: false,
      message: "Não foi possível entrar agora. Tente novamente em instantes.",
    };
  } catch {
    return {
      ok: false,
      message:
        "Não conseguimos falar com o serviço de autenticação. Verifique a sua conexão.",
    };
  }
}

/**
 * Valida o nome informado na criação de conta.
 *
 * @param name - Valor digitado.
 * @returns Mensagem de erro, ou `undefined` quando o valor é aceitável.
 */
export function validateName(name: string): string | undefined {
  if (!name.trim()) return "Informe o seu nome.";
  return undefined;
}

/**
 * Valida a senha escolhida na criação de conta.
 *
 * Diferente da validação de entrada, aqui o tamanho importa: é o momento em
 * que a senha nasce, e o provedor exige o mínimo de oito caracteres.
 *
 * @param password - Valor digitado.
 * @returns Mensagem de erro, ou `undefined` quando o valor é aceitável.
 */
export function validateNewPassword(password: string): string | undefined {
  if (!password) return "Escolha uma senha.";
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `A senha precisa de pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  }
  return undefined;
}

/**
 * Cria uma conta no provedor de identidade e já abre a sessão.
 *
 * O cookie de sessão volta na própria resposta do registro: quem acabou de se
 * cadastrar entra direto, sem digitar a mesma senha de novo.
 *
 * @param data - Nome, e-mail e senha escolhidos.
 * @returns Resultado da tentativa, com o campo culpado quando houver um.
 */
export async function signUp({
  name,
  email,
  password,
}: SignUpData): Promise<SignUpResult> {
  if (!API_BASE_URL) {
    return {
      ok: false,
      message:
        "O serviço de contas não está configurado neste ambiente. Use a entrada de demonstração.",
    };
  }

  try {
    const response = await fetch(`${API_BASE_URL}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        name: name.trim(),
        email: email.trim().toLowerCase(),
        password,
      }),
    });

    if (response.ok) {
      return { ok: true, name: name.trim() };
    }

    if (response.status === 409) {
      return {
        ok: false,
        field: "email",
        message: "Este e-mail já está registrado. Entre com a sua senha.",
      };
    }

    if (response.status === 404 || response.status === 501) {
      return {
        ok: false,
        message:
          "A criação de conta ainda não está publicada neste ambiente da API.",
      };
    }

    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;

    return {
      ok: false,
      message:
        body?.error?.message ??
        "Não foi possível criar a conta agora. Tente novamente em instantes.",
    };
  } catch {
    return {
      ok: false,
      message:
        "Não conseguimos falar com o serviço de contas. Verifique a sua conexão.",
    };
  }
}

/**
 * Endereço do fluxo de entrada por SSO corporativo.
 *
 * @returns URL de redirecionamento, ou `undefined` quando a API não está configurada.
 */
export function ssoEntryPoint(): string | undefined {
  if (!API_BASE_URL) return undefined;
  return `${API_BASE_URL}/auth/sso`;
}
