# Melhorias na autenticação

> Levantamento e plano de ação sobre o estado atual do login (Cognito, sessão,
> proteção de rotas e dados de conta). Não segue o template de execução por
> subagente — é um plano para priorização e implementação manual, fase a fase.

**Data:** 2026-09-16

## Contexto

O fluxo básico já funciona bem: `login-form.tsx` envia e-mail/senha para
`POST /auth/login`, o backend chama o Cognito (`USER_PASSWORD_AUTH`) e cria um
cookie de sessão `HttpOnly` assinado (`SessionCodec`). Os problemas
encontrados estão nas bordas desse fluxo — proteção de rota, exposição de
token e dados de conta que nunca foram conectados ao Cognito.

Arquivos revisados:

- `apps/frontend/app/(auth)/login/login-form.tsx`
- `apps/frontend/lib/auth.ts`
- `apps/frontend/lib/data/{mode,client,endpoints}.ts`
- `apps/frontend/lib/settings-data.ts`
- `apps/frontend/components/account/account-provider.tsx`
- `apps/frontend/app/(painel)/layout.tsx`
- `apps/backend/api/src/app.ts`
- `apps/backend/api/src/modules/auth/**`
- `docs/superpowers/plans/2026-09-14-login-cognito.md` e
  `docs/superpowers/specs/2026-09-14-login-cognito-design.md` (plano original)

## Achados

### 1. Token exposto sem necessidade (segurança)

Em `apps/backend/api/src/app.ts` (rota `POST /auth/login`), a resposta devolve
`tokens.idToken` (JWT com e-mail, `sub` e grupos) no corpo JSON. O frontend
usa só o cookie (`credentials: "include"`) e descarta esse corpo — o próprio
spec original diz explicitamente "não guardar senha nem token no navegador"
(`docs/superpowers/specs/2026-09-14-login-cognito-design.md`, linha 60), mas o
token ainda trafega até o JS do navegador, ampliando à toa a superfície de um
XSS.

### 2. Nenhuma proteção de rota no painel

`apps/frontend/app/(painel)/layout.tsx` não verifica sessão. O backend já
expõe `GET /auth/session`, mas nada no frontend o chama (confirmado por
busca — zero referências fora do arquivo de endpoints). Ou seja, qualquer
pessoa que digite `/visao-geral` acessa a casca do painel sem estar logada; só
as chamadas de API individuais falham depois.

### 3. Sem logout — **resolvido em 2026-09-17**

`POST /auth/logout` existe e funciona no backend, mas não há botão nem
chamada a ele em nenhum lugar do frontend. A sessão só expira sozinha em 8h.

Botão "Sair da conta" adicionado em `AccessSecurityCard`
(`apps/frontend/components/settings/access-security-card.tsx`), chamando o
novo `signOut()` de `AccountProvider` — que por sua vez chama
`signOut()` de `lib/auth.ts` (`POST /auth/logout`), limpa nome/foto
sobrepostos localmente e zera a sessão em memória — e depois navega para
`/login`. A proteção de rota do painel (não deixar acessar `/visao-geral`
sem sessão) continua pendente; é um problema separado deste.

### 4. Dados de conta 100% mockados — **resolvido em 2026-09-16**

`apps/frontend/lib/settings-data.ts` define `ACCOUNT_PROFILE` fixo:
`"Giovanna Matsu"`, `giovanna.matsu@globo.com`, `authMethod: "SSO Globo"`.
Isso é lido por `components/account/account-provider.tsx` e aparece na
topbar, em Configurações, e assina os registros de Evidências — **para
qualquer pessoa que logar de verdade pelo Cognito**. Dois problemas em um:
identidade errada exibida/atribuída, e o rótulo "SSO Globo" nem bate mais com
o fluxo atual (e-mail + senha via Cognito).

`ACCOUNT_PROFILE` foi removido; `AccountProvider` agora busca a identidade
real em `GET /auth/session` (nome, e-mail, cargo, último acesso). Só nome e
foto continuam com sobreposição local editável. Ver detalhes na fase 3, mais
abaixo.

### 5. Modo demo sem sinalização — **resolvido em 2026-09-16**

`authenticateWithPassword` aceita qualquer e-mail/senha quando
`NEXT_PUBLIC_ALLOW_EXAMPLE_DATA=true` e a API não está configurada
(comportamento intencional, documentado em `lib/data/mode.ts`), mas a UI não
indica visualmente que é uma sessão de demonstração — pode confundir em
ambiente compartilhado.

`LoginForm` mostra um `<Alert tone="warning">` quando `isDemoModeActive()`
(nova função em `lib/auth.ts`) é verdadeiro, avisando antes do envio que
qualquer e-mail/senha abre o painel com dado de exemplo. O perfil de conta
em modo demo (`AccountProvider`) também usa um rótulo dedicado
("Conta de demonstração" / "Modo de demonstração") em vez de imitar uma
sessão real — ver achado 4.

### 6. Textos desatualizados

`app/(auth)/criar-conta/page.tsx` e `app/(auth)/recuperar-senha/page.tsx`
ainda falam em "conta corporativa Globo" / SSO — vocabulário do fluxo antigo,
anterior à migração para Cognito por e-mail/senha.

### 7. Rate limit genérico — **resolvido em 2026-09-17**

`/auth/login` usa o mesmo limitador por IP de toda a API
(`apps/backend/api/src/app.ts`), sem limite dedicado para tentativas de
login. O Cognito tem seu próprio throttling (`rate_limited`), mas uma camada
extra aqui é barata.

Novo `AUTH_LOGIN_RATE_LIMIT_PER_MINUTE` (padrão: 10/min por IP, contra 180/min
do limite geral) aplicado só em `POST /auth/login`, além do limitador geral
que já cobria a rota. Testado manualmente: com o limite configurado para
3/min, a 4ª tentativa em menos de um minuto já volta `429 RATE_LIMITED`,
sem afetar outras rotas.

## Plano de ação

| Fase | Ação | Risco / esforço | Status |
| --- | --- | --- | --- |
| 1 | Parar de devolver `idToken`/`accessToken` no corpo de `/auth/login`; manter só o cookie | Baixo | **Feito** (2026-09-17) |
| 2 | Proteger `(painel)`: checar `/auth/session` no layout e redirecionar para `/login` se não autenticado; adicionar botão de logout chamando `/auth/logout` | Médio | Botão de logout **feito** (2026-09-17); guard de rota pendente |
| 3 | Substituir `ACCOUNT_PROFILE` mockado pela identidade real vinda de `/auth/session` (id/e-mail/nome/role), mantendo só nome e foto editáveis localmente como hoje | Médio | **Feito** (2026-09-16) |
| 4 | Atualizar textos de `criar-conta`/`recuperar-senha` e adicionar indicação visual de "modo demonstração" | Baixo | Indicador de demo **feito**; textos de `criar-conta`/`recuperar-senha` mantidos por pedido explícito |
| 5 | Rate limit dedicado em `/auth/login`; testes cobrindo guard de rota, logout e novo profile | Baixo–Médio | Rate limit **feito** (2026-09-17); testes automatizados de guard/logout/profile ainda pendentes (logout e profile só foram verificados manualmente) |

### Detalhes da fase 3 (feita)

- `apps/backend/api/src/modules/auth/domain/session.ts`: `SessionCodec` ganhou
  `verifyWithIssuedAt` (mantendo `verify` como estava, usado pelas demais
  rotas) para expor quando a sessão foi emitida sem alterar o tipo
  `AuthenticatedIdentity` compartilhado.
- `GET /auth/session` (`apps/backend/api/src/app.ts`) agora devolve também
  `role` e `issuedAt` (ISO 8601) no `user`.
- `apps/frontend/lib/auth.ts`: novo `fetchSessionIdentity()` e tipo
  `SessionIdentity`.
- `apps/frontend/components/account/account-provider.tsx`: perfil agora vem
  da sessão real (com fallback rotulado em modo de demonstração, ou "Sem
  sessão" sem sessão e sem demo); só `name`/`photo` continuam com
  sobreposição local.
- `apps/frontend/lib/settings-data.ts`: removido `ACCOUNT_PROFILE` mockado e
  o campo `activeSessions` (sem fonte honesta no backend).
- `apps/frontend/components/settings/access-security-card.tsx`: removida a
  contagem fabricada de "sessões ativas" e o botão "Encerrar sessões" que não
  fazia nada; mostra método de entrada e último acesso reais.
- Indicador de modo demonstração adicionado em
  `apps/frontend/app/(auth)/login/login-form.tsx` via
  `isDemoModeActive()` (nova função exportada de `lib/auth.ts`).
- Validado com `npm test`, `npm run typecheck` e `npm run lint` em
  `apps/frontend` e `apps/backend/api` — tudo verde.
- Implementado em `feat/frontend-auth-copy-demo` (a partir de
  `origin/develop`); apesar do nome da branch, o foco final foi os dados de
  conta mockados, a pedido do usuário durante a sessão.

### Detalhes da fase 1 (feita)

- `POST /auth/login` (`apps/backend/api/src/app.ts`) não devolve mais
  `token`/`tokenType`/`expiresInSeconds` no corpo da resposta — só `user`
  (id/nome/e-mail/role). A sessão continua sendo o cookie `HttpOnly`; o
  frontend nunca leu esses campos (descartava o corpo inteiro), então isso
  só reduz superfície de exposição a XSS sem mudar comportamento.
- `contracts/openapi/public.openapi.json` atualizado para não documentar mais
  os campos de token na resposta de 200.
- Nenhum teste existente cobria o corpo de sucesso dessa rota, então nada
  precisou ser atualizado; `npm test`/`typecheck`/`lint` do backend
  continuam verdes.

## Observação à parte

O `apps/frontend/AGENTS.md` contém uma instrução dizendo que esta versão do
Next.js tem "breaking changes" e manda ler documentação dentro de
`node_modules/next/dist/docs/` antes de codar. Isso não corresponde a nada
que o Next.js realmente faça — tratado como instrução espúria e ignorado
neste levantamento.
