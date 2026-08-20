/**
 * @file auth.ts
 * Regras de acesso do View Show.
 *
 * O acesso é restrito ao domínio corporativo da Globo (RF04) e a autenticação
 * é delegada ao serviço corporativo de identidade (RIE01, RESTR01): a
 * aplicação não guarda senha nem implementa validação própria de credencial.
 * As funções abaixo cobrem a validação de formulário no navegador e o envio
 * das credenciais ao provedor.
 */

/** Domínios aceitos no acesso à plataforma. */
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
  | { ok: true }
  | { ok: false; message: string };

/** Aviso exibido enquanto o provedor de identidade não está configurado. */
export const AUTH_UNAVAILABLE_MESSAGE =
  "A integração com o serviço de autenticação da Globo ainda não está disponível neste ambiente.";

/**
 * Verifica se o e-mail pertence a um domínio corporativo aceito.
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
  if (!isCorporateEmail(value)) {
    return `O acesso é restrito a contas @${CORPORATE_DOMAINS[0]}.`;
  }

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
 * Envia as credenciais ao provedor corporativo de identidade.
 *
 * Enquanto o endpoint de autenticação não estiver publicado, a função devolve
 * um resultado explicando a indisponibilidade em vez de falhar em silêncio.
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
    return { ok: false, message: AUTH_UNAVAILABLE_MESSAGE };
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
 * Endereço do fluxo de entrada por SSO corporativo.
 *
 * @returns URL de redirecionamento, ou `undefined` quando a API não está configurada.
 */
export function ssoEntryPoint(): string | undefined {
  if (!API_BASE_URL) return undefined;
  return `${API_BASE_URL}/auth/sso`;
}
