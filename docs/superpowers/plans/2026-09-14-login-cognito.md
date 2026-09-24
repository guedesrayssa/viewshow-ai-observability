# Login com Cognito Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir a entrada SSO inoperante por login com e-mail e senha usando o endpoint Cognito já publicado.

**Architecture:** O Client Component envia as credenciais por HTTPS ao backend na mesma origem. O backend já chama o Cognito, cria o cookie `HttpOnly` e responde sem exigir acesso direto do navegador ao client secret.

**Tech Stack:** Next.js 16, React 19, TypeScript, Vitest, Testing Library, API Express existente e Terraform existente.

**Spec:** `docs/superpowers/specs/2026-09-14-login-cognito-design.md`

## Global Constraints

- Não copiar IDs de User Pool ou app client entre contas do Learner Lab.
- Não colocar senha, token ou client secret em código, Git, `localStorage` ou `sessionStorage`.
- Não alterar nem destruir a infraestrutura Terraform existente.
- Usar `POST /auth/login`, já publicado e protegido por HTTPS.
- Seguir TDD: observar cada teste falhar pelo motivo esperado antes da implementação.

---

### Task 1: Cliente de autenticação por senha

**Files:**
- Modify: `apps/frontend/lib/auth.ts`
- Test: `apps/frontend/tests/client-and-review.test.ts`

**Interfaces:**
- Consumes: `gatewayUrl(ENDPOINTS.auth.login)` e `isApiConfigured()`.
- Produces: `authenticateWithPassword(username: string, password: string): Promise<PasswordAuthenticationDecision>`.

- [ ] **Step 1: Substituir os testes do redirecionamento SSO por testes de login por senha**

Em `apps/frontend/tests/client-and-review.test.ts`, substituir os três testes de `beginAuthentication()` por:

```ts
it("authenticates through the backend without exposing Cognito configuration", async () => {
  vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://operacional.test");
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify({ data: { user: { email: "ana@globo.com" } }, meta }), { status: 200 });
  }));
  const { authenticateWithPassword } = await import("@/lib/auth");

  await expect(authenticateWithPassword(" ana@globo.com ", "Senha123")).resolves.toEqual({ kind: "authenticated" });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe("http://operacional.test/auth/login");
  expect(requests[0]?.init).toMatchObject({
    method: "POST",
    credentials: "include",
    cache: "no-store",
    body: JSON.stringify({ username: "ana@globo.com", password: "Senha123" }),
  });
});

it("returns a simple message for invalid credentials", async () => {
  vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://operacional.test");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED" } }), { status: 401 })));
  const { authenticateWithPassword } = await import("@/lib/auth");

  await expect(authenticateWithPassword("ana@globo.com", "errada")).resolves.toEqual({
    kind: "error",
    message: "E-mail ou senha incorretos.",
  });
});

it("keeps demo mode available without sending credentials", async () => {
  vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "");
  vi.stubEnv("NEXT_PUBLIC_ALLOW_EXAMPLE_DATA", "true");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const { authenticateWithPassword } = await import("@/lib/auth");

  await expect(authenticateWithPassword("ana@globo.com", "Senha123")).resolves.toEqual({ kind: "demo" });
  expect(fetch).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Executar os testes e confirmar a falha correta**

Run:

```bash
npm --prefix apps/frontend test -- tests/client-and-review.test.ts
```

Expected: FAIL porque `authenticateWithPassword` ainda não existe.

- [ ] **Step 3: Implementar o cliente mínimo**

Substituir `beginAuthentication` e seus tipos em `apps/frontend/lib/auth.ts` por:

```ts
export type PasswordAuthenticationDecision =
  | { kind: "authenticated" }
  | { kind: "demo" }
  | { kind: "error"; message: string };

function authenticationErrorMessage(status: number): string {
  if (status === 401) return "E-mail ou senha incorretos.";
  if (status === 403) return "Este usuário ainda não está liberado para entrar.";
  if (status === 429) return "Muitas tentativas. Aguarde um pouco e tente novamente.";
  return "Não foi possível entrar agora. Tente novamente em instantes.";
}

export async function authenticateWithPassword(
  username: string,
  password: string,
): Promise<PasswordAuthenticationDecision> {
  if (!isApiConfigured()) {
    return ALLOW_EXAMPLE_DATA
      ? { kind: "demo" }
      : { kind: "error", message: AUTH_UNAVAILABLE_MESSAGE };
  }
  try {
    const response = await fetch(gatewayUrl(ENDPOINTS.auth.login), {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      credentials: "include",
      cache: "no-store",
      body: JSON.stringify({ username: username.trim(), password }),
    });
    if (!response.ok) {
      return { kind: "error", message: authenticationErrorMessage(response.status) };
    }
    return { kind: "authenticated" };
  } catch {
    return { kind: "error", message: AUTH_UNAVAILABLE_MESSAGE };
  }
}
```

Atualizar `AUTH_UNAVAILABLE_MESSAGE` para:

```ts
export const AUTH_UNAVAILABLE_MESSAGE =
  "Não foi possível entrar agora. Tente novamente em instantes.";
```

- [ ] **Step 4: Executar os testes do cliente**

Run:

```bash
npm --prefix apps/frontend test -- tests/client-and-review.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commitar o cliente**

```bash
git add apps/frontend/lib/auth.ts apps/frontend/tests/client-and-review.test.ts
git commit -m "feat(frontend): conecta login ao Cognito"
```

---

### Task 2: Formulário de e-mail e senha

**Files:**
- Modify: `apps/frontend/app/(auth)/login/login-form.tsx`
- Test: `apps/frontend/app/(auth)/login/login-form.test.tsx`

**Interfaces:**
- Consumes: `authenticateWithPassword(username, password)` da Task 1.
- Produces: formulário acessível que navega para `/visao-geral` após autenticação.

- [ ] **Step 1: Escrever testes de interface que falham**

Substituir o primeiro teste de `login-form.test.tsx` por um teste que renderiza os campos, envia o formulário e verifica o POST real através de `authenticateWithPassword`:

```ts
it("submits email and password and opens the dashboard", async () => {
  vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://operacional.test");
  const fetch = vi.fn(async () => new Response(JSON.stringify({ data: {}, meta: {} }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  await renderLoginForm();

  await userEvent.type(screen.getByRole("textbox", { name: /e-mail/i }), "ana@globo.com");
  await userEvent.type(screen.getByLabelText(/^senha$/i), "Senha123");
  await userEvent.click(screen.getByRole("button", { name: /^entrar$/i }));

  expect(fetch).toHaveBeenCalledOnce();
  expect(push).toHaveBeenCalledWith("/visao-geral");
});
```

Adicionar o teste de falha e descarte da senha:

```ts
it("shows a simple error and clears the password after a failed login", async () => {
  vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://operacional.test");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED" } }), { status: 401 })));
  await renderLoginForm();

  await userEvent.type(screen.getByRole("textbox", { name: /e-mail/i }), "ana@globo.com");
  const password = screen.getByLabelText(/^senha$/i);
  await userEvent.type(password, "errada");
  await userEvent.click(screen.getByRole("button", { name: /^entrar$/i }));

  expect(await screen.findByText("E-mail ou senha incorretos.")).toBeInTheDocument();
  expect(password).toHaveValue("");
  expect(push).not.toHaveBeenCalled();
});
```

Substituir o teste de demonstração por:

```ts
it("opens the dashboard without a request in demo mode", async () => {
  vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "");
  vi.stubEnv("NEXT_PUBLIC_ALLOW_EXAMPLE_DATA", "true");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await renderLoginForm();

  await userEvent.type(screen.getByRole("textbox", { name: /e-mail/i }), "ana@globo.com");
  await userEvent.type(screen.getByLabelText(/^senha$/i), "Senha123");
  await userEvent.click(screen.getByRole("button", { name: /^entrar$/i }));

  expect(push).toHaveBeenCalledWith("/visao-geral");
  expect(fetch).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Executar o teste e confirmar a falha correta**

Run:

```bash
npm --prefix apps/frontend test -- 'app/(auth)/login/login-form.test.tsx'
```

Expected: FAIL porque a tela ainda não possui os campos de e-mail e senha.

- [ ] **Step 3: Implementar o formulário mínimo**

Em `login-form.tsx`:

- importar `FormEvent`, `TextField`, `PasswordField` e `authenticateWithPassword`;
- manter estados `email`, `password`, `formError` e `submitting`;
- renderizar `<form onSubmit={handleSubmit}>`;
- usar `type="email"`, `autoComplete="email"`, `required` no e-mail;
- usar `autoComplete="current-password"`, `required` na senha;
- usar `<Button type="submit" loading={submitting} fullWidth>Entrar</Button>`;
- no envio, limpar erro, chamar `authenticateWithPassword(email, password)`, apagar `password` e navegar para `/visao-geral` quando o resultado for `authenticated` ou `demo`;
- sempre finalizar `submitting` em `finally`.

O manipulador terá esta forma:

```ts
async function handleSubmit(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  setFormError(undefined);
  setSubmitting(true);
  try {
    const decision = await authenticateWithPassword(email, password);
    setPassword("");
    if (decision.kind === "authenticated" || decision.kind === "demo") {
      router.push("/visao-geral");
      return;
    }
    setFormError(decision.message);
  } finally {
    setSubmitting(false);
  }
}
```

O conteúdo retornado pelo componente terá esta estrutura:

```tsx
<form className={cn("flex flex-col gap-6", className)} onSubmit={handleSubmit}>
  {formError ? <Alert tone="critical">{formError}</Alert> : null}
  <TextField
    label="E-mail"
    type="email"
    autoComplete="email"
    value={email}
    onChange={(event) => setEmail(event.target.value)}
    required
    disabled={submitting}
  />
  <PasswordField
    label="Senha"
    autoComplete="current-password"
    value={password}
    onChange={(event) => setPassword(event.target.value)}
    required
    disabled={submitting}
  />
  <Button type="submit" fullWidth loading={submitting}>
    Entrar
  </Button>
</form>
```

- [ ] **Step 4: Executar os testes do formulário**

Run:

```bash
npm --prefix apps/frontend test -- 'app/(auth)/login/login-form.test.tsx'
```

Expected: PASS.

- [ ] **Step 5: Commitar o formulário**

```bash
git add 'apps/frontend/app/(auth)/login/login-form.tsx' 'apps/frontend/app/(auth)/login/login-form.test.tsx'
git commit -m "feat(frontend): adiciona formulário de login"
```

---

### Task 3: Comandos compartilháveis e documentação

**Files:**
- Modify: `apps/fullstack/README.md`
- Modify: `apps/frontend/docs/autenticacao.md`
- Modify: `apps/frontend/docs/deploy-aws-integrado.md`
- Modify: `apps/frontend/app/(auth)/login/page.tsx`

**Interfaces:**
- Consumes: output Terraform `cognito_user_pool_id` e o fluxo das Tasks 1 e 2.
- Produces: instrução copiável que funciona em qualquer conta do Learner Lab com estado próprio.

- [ ] **Step 1: Atualizar o texto da página**

Em `login/page.tsx`, trocar as referências a SSO e conta corporativa por “e-mail e senha cadastrados no ambiente”. Manter título e layout.

- [ ] **Step 2: Documentar o comando sem IDs fixos**

Adicionar ao `apps/fullstack/README.md` uma seção `## Criar usuário do Cognito` com o bloco aprovado no spec. O primeiro comando deve ser exatamente:

```bash
G05_COGNITO_POOL_ID="$(terraform -chdir=apps/fullstack output -raw cognito_user_pool_id)"
```

Incluir `admin-create-user`, `admin-set-user-password --permanent`, `admin-get-user --query UserStatus --output text` e `unset G05_COGNITO_PASSWORD`. Informar que o resultado esperado é `CONFIRMED`.

- [ ] **Step 3: Alinhar a documentação do frontend**

Em `apps/frontend/docs/autenticacao.md` e `apps/frontend/docs/deploy-aws-integrado.md`, remover as afirmações de “somente superfície federada”, `GET /auth/login` e `503` permanente. Documentar o formulário, `POST /auth/login`, o cookie `HttpOnly` e a navegação para `/visao-geral`.

- [ ] **Step 4: Validar o projeto completo**

Run:

```bash
npm --prefix apps/frontend test
npm --prefix apps/frontend run lint
npm --prefix apps/frontend run typecheck
npm --prefix apps/frontend run build
npm --prefix apps/backend/api test
npm --prefix apps/backend/api run typecheck
git diff --check
```

Expected: todos os comandos terminam com código 0 e sem falhas.

- [ ] **Step 5: Confirmar que nenhum ID do Learner Lab vazou na documentação operacional**

Run:

```bash
rg -n 'us-east-1_ZRoG5bqCE|1i7o39c3bi034gdusrd1lvqls5' apps/fullstack/README.md apps/frontend
```

Expected: nenhuma ocorrência.

- [ ] **Step 6: Commitar a documentação**

```bash
git add apps/fullstack/README.md apps/frontend/docs/autenticacao.md apps/frontend/docs/deploy-aws-integrado.md 'apps/frontend/app/(auth)/login/page.tsx'
git commit -m "docs: explica configuração portátil do Cognito"
```
