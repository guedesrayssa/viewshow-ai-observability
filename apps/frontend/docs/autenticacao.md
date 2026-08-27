# Autenticação e conta

> Parte da [documentação do frontend](../documentacao-frontend.md). Este documento
> detalha o acesso e o perfil em sessão; a visão geral está na seção 8 do índice.

O View Show não guarda senha nem valida credencial: a autenticação é delegada ao
serviço de identidade (RIE01, RESTR01).

## `lib/auth.ts`

| Export | Assinatura | Papel |
| --- | --- | --- |
| `CORPORATE_DOMAINS` | `["globo.com"]` | Domínios corporativos, para o exemplo de preenchimento e o SSO. |
| `isCorporateEmail(email)` | `→ boolean` | Reconhece a conta corporativa para **sugerir** o SSO. Não restringe a entrada. |
| `validateEmail(email)` | `→ string \| undefined` | Formato mínimo: algo `@` domínio com ponto, sem espaços. |
| `validatePassword(password)` | `→ string \| undefined` | Só verifica preenchimento. |
| `signIn({ email, password })` | `→ Promise<SignInResult>` | Envia as credenciais. |
| `ssoEntryPoint()` | `→ string \| undefined` | URL do fluxo de SSO, ou `undefined` sem API configurada. |
| `AUTH_UNAVAILABLE_MESSAGE` | `string` | Aviso quando o SSO não está configurado. |

```ts
type SignInResult =
  | { ok: true; demo?: boolean }        // demo = sessão sem provedor por trás
  | { ok: false; message: string };
```

## Fluxo de login

`app/(auth)/login/login-form.tsx` (`"use client"`): `handleSubmit` chama
`preventDefault`, valida os dois campos, leva o foco ao primeiro inválido, então
`await signIn(...)`. `ok: false` → `<Alert tone="critical">` com `result.message`.
`ok: true` → `router.push("/visao-geral")`.

**Com API configurada:**

```
POST {NEXT_PUBLIC_API_BASE_URL}/auth/login
Content-Type: application/json
credentials: "include"        // a sessão volta como cookie assinado —
                              // o token não passa por localStorage
body: { email: <minúsculas, sem espaços>, password }
```

| Resposta | Resultado |
| --- | --- |
| `2xx` | `{ ok: true }` → vai para `/visao-geral` |
| `401` / `403` | "E-mail ou senha incorretos. Verifique e tente novamente." |
| Outro status | "Não foi possível entrar agora. Tente novamente em instantes." |
| Falha de rede | "Não conseguimos falar com o serviço de autenticação. Verifique a sua conexão." |

## Sessão de demonstração

**Sem `NEXT_PUBLIC_API_BASE_URL`**, `signIn` devolve `{ ok: true, demo: true }`
sem tocar na rede. Travar o acesso deixaria a plataforma inalcançável num
ambiente sem backend; o painel inteiro funciona com o conjunto de exemplo. Nada é
persistido no navegador por esta camada. A flag `demo` permite à interface dizer
que a sessão não tem provedor de identidade por trás.

## SSO Globo

O botão "Entrar com SSO Globo" chama `handleSso()`: `ssoEntryPoint()` devolve
`{API}/auth/sso` quando há API, ou `undefined`. Com URL:
`window.location.assign(ssoUrl)`. Sem URL: mostra `AUTH_UNAVAILABLE_MESSAGE` — a
ação **explica** a indisponibilidade em vez de ficar desabilitada.

## Recuperação de senha

`/recuperar-senha` é estática. A senha pertence ao provedor corporativo
(RESTR01). A tela orienta a procurar o suporte interno de TI e volta ao login.

## Perfil da conta (`AccountProvider`)

```ts
const { profile, updateProfile, reset } = useAccount();
// profile: AccountProfile & { photo: string | null }
// updateProfile(patch: Partial<{ name: string; photo: string | null }>)
// reset(): volta ao nome do provedor e remove a foto
```

`AccountProfile` (de `lib/settings-data.ts`): `name`, `email`, `role`,
`authMethod`, `lastAccess`, `activeSessions`. Editáveis pela pessoa: **só `name` e
`photo`**. Persistido em `localStorage` via `createPersistedJson` (chave
`view-show:account`). Quando a API de conta existir, `updateProfile` passa a
enviá-la e **nenhuma tela muda**.

| Campo | Quando vale | Onde | Por quê |
| --- | --- | --- | --- |
| **Foto** | Na hora | `ProfileCard` | Escolher a imagem já é a confirmação; trocar/remover desfaz. |
| **Nome** | Só ao salvar | `AccountDetailsCard` | Ele assina registros em Evidências — a alteração passa por confirmação explícita. |

Sem foto, o `Avatar` mostra as **iniciais** do nome sobre o gradiente da marca.

## Foto de perfil (`lib/image.ts`)

`readSquareImage(file): Promise<string>` — converte o arquivo num data URL
quadrado e reduzido, **no navegador**, antes de guardar.

| Constante | Valor |
| --- | --- |
| `MAX_SIDE` | `320` px — lado da imagem guardada |
| `MAX_UPLOAD_BYTES` | `8 * 1024 * 1024` (8 MB) — tamanho máximo do original |
| `ACCEPTED_IMAGE_TYPES` | `image/jpeg`, `image/png`, `image/webp` |

Erros (`ImageError`): `tipo-invalido`, `arquivo-grande`, `leitura-falhou`, com
mensagens em `IMAGE_ERROR_MESSAGES`. O corte é **central**. A saída é
`canvas.toDataURL("image/jpeg", 0.85)`.
