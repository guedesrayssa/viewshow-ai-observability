# Autenticação e conta

> Parte da [documentação do frontend](../documentacao-frontend.md). Este documento
> detalha o acesso e o perfil em sessão; a visão geral está na seção 8 do índice.

O View Show recebe e-mail e senha na tela de login e os envia por HTTPS ao
backend. O backend confere a credencial no Cognito e cria um cookie de sessão;
o client secret nunca vai para o navegador.

## `lib/auth.ts`

| Export | Assinatura | Papel |
| --- | --- | --- |
| `authenticateWithPassword()` | `(username, password) → Promise<PasswordAuthenticationDecision>` | Envia a credencial ao backend ou abre a demonstração local. |
| `AUTH_UNAVAILABLE_MESSAGE` | `string` | Aviso quando o serviço de login não responde. |

```ts
type PasswordAuthenticationDecision =
  | { kind: "authenticated" }
  | { kind: "demo" }
  | { kind: "error"; message: string };
```

## Contrato da API

`ENDPOINTS.auth` expõe estes caminhos públicos:

| Caminho | Papel |
| --- | --- |
| `POST /auth/login` | Confere e-mail e senha no Cognito e cria a sessão. |
| `/auth/logout` | Encerra a sessão. |
| `/auth/session` | Consulta a sessão atual. |

Não há cadastro público nem redefinição automática de senha. Usuários são
criados pelo responsável pelo ambiente com os comandos de
`apps/fullstack/README.md`.

## Fluxo de login

`app/(auth)/login/login-form.tsx` é um componente cliente com campos de e-mail
e senha. Ao enviar, chama `authenticateWithPassword()`:

| Decisão | Ação da interface |
| --- | --- |
| `{ kind: "authenticated" }` | Abre `/visao-geral`. |
| `{ kind: "demo" }` | `router.push("/visao-geral")`. |
| `{ kind: "error", message }` | Mostra `<Alert tone="critical">` e limpa a senha. |

Com `NEXT_PUBLIC_API_BASE_URL` configurada, o frontend faz `POST /auth/login`
com `credentials: "include"`. Sem API, a demonstração só é aberta quando
`NEXT_PUBLIC_ALLOW_EXAMPLE_DATA=true` e o ambiente não é de produção; do
contrário, a interface informa indisponibilidade. A senha não é persistida.

## Páginas auxiliares de acesso

As páginas de criação de conta e de recuperação de acesso são informativas:
orientam a procurar o suporte interno de TI e oferecem retorno ao login. Nenhuma
delas chama a API.

## Perfil da conta (`AccountProvider`)

```ts
const { profile, updateProfile, reset } = useAccount();
// profile: AccountProfile & { photo: string | null }
// updateProfile(patch: Partial<{ name: string | null; photo: string | null }>)
// reset(): remove o nome sobreposto e a foto; volta ao nome da sessão
```

`AccountProfile` (`name`, `email`, `role`, `authMethod`, `lastAccess`) vem de
`GET /auth/session` — é a identidade real de quem logou pelo Cognito, não um
valor fixo. `role` é o grupo do Cognito traduzido (`admin` → "Administrador(a)"
etc.) e `lastAccess` é o horário de emissão da sessão em cookie. Sem sessão
válida, o perfil cai para "Sem sessão" (ou, em modo de demonstração, para um
perfil claramente rotulado como tal — ver `isDemoModeActive()`).

Editáveis pela pessoa: **só `name` e `photo`**, sobrepostos localmente em
`localStorage` via `createPersistedJson` (chave `view-show:account`); os
demais campos não têm edição porque descrevem a sessão, não a pessoa.

Não existe "sessões ativas": o backend não mantém um registro de sessões
concorrentes, então esse número não teria origem — mostrar um valor
inventado violaria a mesma regra que `ALLOW_EXAMPLE_DATA` já aplica ao
restante do painel.

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
