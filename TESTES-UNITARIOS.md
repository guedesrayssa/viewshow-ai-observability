# Testes Unitários — Resultados e Guia de Execução

&emsp;Este documento cobre a **Seção 1 (Testes Unitários)** do plano em [`artefatos/sprint4/testes-funcionais.md`](artefatos/sprint4/testes-funcionais.md): o que cada teste valida, o resultado obtido ao rodar a suíte e como qualquer pessoa (sem depender do Claude) consegue reproduzir esses resultados na própria máquina.

&emsp;Alvo: `apps/backend/api` (monólito modular TypeScript, Express 5, DynamoDB), suíte de testes em Vitest.

## Status geral

| Item | Valor |
| --- | --- |
| Testes unitários planejados (UT01–UT04) | 4 |
| Já existiam antes desta rodada | UT01, UT02, UT03 |
| Escrito nesta rodada | **UT04** (`tests/contracts.test.ts`, teste `"enforces the limit boundaries (1-100, default 20) on incidentsQuerySchema"`) |
| Resultado dos 4 testes unitários | ✅ 31/31 passando (arquivos `domain.test.ts`, `auth-password-login.test.ts`, `contracts.test.ts`) |
| Resultado da suíte completa (11 arquivos) | ✅ 71 passando, 1 ignorado (72 no total — antes eram 70+1=71; o novo UT04 soma 1) |

&emsp;Evidências brutas (saída completa do terminal) ficam em [`assets/testes-funcionais/2026-09-17/`](assets/testes-funcionais/2026-09-17/):
- `resultado-vitest-unitarios.txt` — só os 3 arquivos que cobrem UT01–UT04, modo verbose (nome de cada teste).
- `resultado-vitest-suite-completa.txt` — saída de `npm test` rodando os 11 arquivos.

---

## O que cada teste unitário valida

### UT01 — `CursorCodec.encode` / `CursorCodec.decode`
**Arquivo:** `apps/backend/api/tests/domain.test.ts` (teste `"encrypts cursors and binds them to filters"`)

Garante que o cursor de paginação da rota `GET /api/v1/incidents`:
- é opaco (não expõe o filtro em texto claro);
- só é aceito de volta para o **mesmo** conjunto de filtros com que foi emitido;
- é rejeitado (`ServiceError`) se o filtro mudar ou se um caractere do cursor for adulterado.

**Por que importa:** sem isso, seria possível manipular o cursor para pular ou repetir páginas, ou usar um cursor de uma consulta filtrada em outra.

### UT02 — `CognitoPasswordAuthenticator.authenticate`
**Arquivo:** `apps/backend/api/tests/auth-password-login.test.ts` (bloco `"CognitoPasswordAuthenticator"`, 9 testes)

Garante que:
- uma credencial válida autentica e devolve identidade + papel (`role`) corretos, extraídos dos grupos do Cognito;
- uma credencial rejeitada pelo Cognito (`NotAuthorizedException`, `UserNotFoundException`, etc.) vira uma falha classificada (`invalid_credentials`, `rate_limited`, ...) — nunca uma exceção não tratada.

**Por que importa:** é a fronteira entre o provedor de identidade externo (Cognito) e o resto do sistema; se um erro do Cognito vazasse como exceção crua, poderia derrubar a rota de login.

### UT03 — `PasswordLoginUseCases.login` (tradução de falha em HTTP)
**Arquivo:** `apps/backend/api/tests/auth-password-login.test.ts` (bloco `"PasswordLoginUseCases"`, 7 testes)

Garante que cada um dos 7 resultados possíveis do autenticador (1 sucesso + 6 razões de falha) é traduzido para o par `(status HTTP, code)` correto — por exemplo `invalid_credentials → 401`, `rate_limited → 429`, `unavailable → 503`.

**Por que importa:** nenhuma falha de autenticação deve escapar como erro genérico `500` — o cliente precisa saber se deve pedir a senha de novo, esperar, ou contatar o suporte.

### UT04 — `incidentsQuerySchema` (validação do parâmetro `limit`) — **novo**
**Arquivo:** `apps/backend/api/tests/contracts.test.ts` (teste `"enforces the limit boundaries (1-100, default 20) on incidentsQuerySchema"`)

Antes desta rodada só existia um teste checando que `limit: "10"` era coagido para `number` — **nenhum teste cobria os extremos do intervalo**. O novo teste cobre:

| Entrada | Resultado esperado |
| --- | --- |
| `{}` (ausente) | `limit === 20` (default) |
| `{ limit: "1" }` | `limit === 1` (extremo inferior válido) |
| `{ limit: "100" }` | `limit === 100` (extremo superior válido) |
| `{ limit: "0" }` | lança erro (abaixo do mínimo) |
| `{ limit: "101" }` | lança erro (acima do máximo) |
| `{ limit: "abc" }` | lança erro (não numérico) |

**Por que importa:** é o único parâmetro numérico com faixa explícita documentada em código (`z.coerce.number().int().min(1).max(100).default(20)`, `contracts/src/index.ts:295`); sem esse teste, um refactor futuro poderia mudar os limites sem que nada quebrasse.

---

## Como rodar os testes sem o Claude

Pré-requisitos: Node.js `>=22 <23` (confira com `node -v`) e as dependências instaladas.

```bash
# a partir da raiz do repositório (g05/)
cd apps/backend/api
npm install        # só na primeira vez, ou quando package.json mudar
```

### Rodar tudo (os 11 arquivos de teste, 72 testes)
```bash
npm test
```
Isso executa `pretest` automaticamente antes (`npm run build:contracts`), que recompila o pacote `@view-show/contracts` — **passo necessário**: se você rodar `npx vitest run` diretamente sem antes buildar o contracts, testes que usam schemas mais novos (como `rumTelemetrySchema`) podem falhar por o `dist/` do pacote estar desatualizado. Usar `npm test` (não `npx vitest`) evita esse problema porque o `pretest` cuida disso.

### Rodar só os 4 testes unitários (UT01–UT04)
```bash
npm test -- tests/domain.test.ts tests/auth-password-login.test.ts tests/contracts.test.ts
```

### Rodar só o teste novo (UT04)
```bash
npm test -- tests/contracts.test.ts -t "enforces the limit boundaries"
```

### Ver o nome de cada teste individual (modo verbose)
```bash
npx vitest run tests/domain.test.ts tests/auth-password-login.test.ts tests/contracts.test.ts --reporter=verbose
```
(rode `npm run build:contracts` manualmente antes, já que aqui não passamos pelo `pretest`)

### Interpretando a saída
- `✓` = teste passou.
- `✗`/`×` = teste falhou — o Vitest imprime o `diff` entre esperado e recebido logo abaixo.
- Linha final `Test Files X passed | Y skipped (Z)` e `Tests A passed | B skipped (C)` = resumo da rodada.
- O teste ignorado (`1 skipped`) é esperado — é `tests/live-e2e-runtime.test.ts`, que só roda com `RUN_LIVE_E2E=true` contra ambiente real (fora do escopo dos testes unitários).

---

## Próximos passos

Este arquivo cobre só a Seção 1 (Testes Unitários). As Seções 2, 3 e 4 do plano em [`artefatos/sprint4/testes-funcionais.md`](artefatos/sprint4/testes-funcionais.md) — IT01/IT02, casos CT-01 a CT-12 e os três níveis de carga funcional — já foram implementadas e executadas em rodadas posteriores; resultados e evidências estão nas tabelas do próprio plano, não aqui.

<div align="center">
<sup>Fonte: Material produzido pelos autores (2026).</sup>
</div>
