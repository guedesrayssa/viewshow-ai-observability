# Autenticação e conta

> Parte da [documentação do frontend](../documentacao-frontend.md). Este documento
> detalha o acesso e o perfil em sessão; a visão geral está na seção 8 do índice.

O View Show inicia a autenticação no serviço corporativo de identidade
(RIE01, RESTR01). O frontend não recebe nem envia credenciais.

## `lib/auth.ts`

| Export | Assinatura | Papel |
| --- | --- | --- |
| `beginAuthentication()` | `→ AuthenticationDecision` | Decide entre redirecionar ao provedor, abrir a demonstração ou informar indisponibilidade. |
| `AUTH_UNAVAILABLE_MESSAGE` | `string` | Aviso quando o SSO não está configurado. |

```ts
type AuthenticationDecision =
  | { kind: "redirect"; url: string }
  | { kind: "demo" }
  | { kind: "unavailable"; message: string };
```

## Contrato da API

`ENDPOINTS.auth` expõe apenas estes caminhos públicos:

| Caminho | Papel |
| --- | --- |
| `GET /auth/login` | Inicia a autenticação federada. |
| `/auth/callback` | Recebe o retorno do provedor de identidade. |
| `/auth/logout` | Encerra a sessão. |
| `/auth/session` | Consulta a sessão atual. |

Não há operações de criação de conta, redefinição de acesso ou envio de
credenciais no frontend.

## Fluxo de login

`app/(auth)/login/login-form.tsx` é um componente cliente com uma única ação
SSO. Ao clicar, chama `beginAuthentication()`:

| Decisão | Ação da interface |
| --- | --- |
| `{ kind: "redirect", url }` | `window.location.assign(url)` leva ao `GET /auth/login`. |
| `{ kind: "demo" }` | `router.push("/visao-geral")`. |
| `{ kind: "unavailable", message }` | Mostra `<Alert tone="critical">` com a mensagem. |

Com `NEXT_PUBLIC_API_BASE_URL` configurada, a decisão é `redirect`. Sem API, a
demonstração só é aberta quando `NEXT_PUBLIC_ALLOW_EXAMPLE_DATA=true` e o
ambiente não é de produção; do contrário, a interface informa indisponibilidade.
Essa decisão não faz chamada HTTP.

## Páginas auxiliares de acesso

As páginas de criação de conta e de recuperação de acesso são informativas:
orientam a procurar o suporte interno de TI e oferecem retorno ao login. Nenhuma
delas chama a API.

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
