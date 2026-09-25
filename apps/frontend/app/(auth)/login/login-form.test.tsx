import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { push, refreshSession } = vi.hoisted(() => ({
  push: vi.fn(),
  refreshSession: vi.fn(),
}));

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const SESSION = {
  id: "user_ana",
  name: "Ana",
  email: "ana@globo.com",
  role: "viewer" as const,
  issuedAt: "2026-09-24T12:00:00.000Z",
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/account/account-provider", () => ({
  useAccount: () => ({ refreshSession }),
}));

beforeEach(() => {
  refreshSession.mockResolvedValue(SESSION);
});

afterEach(() => {
  push.mockReset();
  refreshSession.mockReset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.stubGlobal("ResizeObserver", NoopObserver);
  vi.stubGlobal("IntersectionObserver", NoopObserver);
  vi.resetModules();
});

async function renderLoginForm(returnTo?: string) {
  const { LoginForm } = await import("./login-form");
  return render(<LoginForm returnTo={returnTo} />);
}

describe("LoginForm", () => {
  it("waits for the renewed session before opening the dashboard", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://operacional.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: {}, meta: {} }), {
            status: 200,
          }),
      ),
    );
    let completeRefresh: (() => void) | undefined;
    refreshSession.mockImplementation(
      () =>
        new Promise<typeof SESSION>((resolve) => {
          completeRefresh = () => resolve(SESSION);
        }),
    );
    await renderLoginForm();

    await userEvent.type(
      screen.getByRole("textbox", { name: /e-mail/i }),
      "ana@globo.com",
    );
    await userEvent.type(screen.getByLabelText(/^senha$/i), "Senha123");
    await userEvent.click(screen.getByRole("button", { name: /^entrar$/i }));

    await waitFor(() => expect(refreshSession).toHaveBeenCalledOnce());
    expect(push).not.toHaveBeenCalled();

    completeRefresh?.();

    await waitFor(() => expect(push).toHaveBeenCalledWith("/visao-geral"));
  });

  it("shows an error instead of opening the dashboard without a renewed session", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://operacional.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: {}, meta: {} }), {
            status: 200,
          }),
      ),
    );
    refreshSession.mockResolvedValue(null);
    await renderLoginForm();

    await userEvent.type(
      screen.getByRole("textbox", { name: /e-mail/i }),
      "ana@globo.com",
    );
    await userEvent.type(screen.getByLabelText(/^senha$/i), "Senha123");
    await userEvent.click(screen.getByRole("button", { name: /^entrar$/i }));

    expect(
      await screen.findByText(
        "Não foi possível entrar agora. Tente novamente em instantes.",
      ),
    ).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("submits email and password and opens the dashboard", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://operacional.test");
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: {}, meta: {} }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetch);
    await renderLoginForm();

    await userEvent.type(
      screen.getByRole("textbox", { name: /e-mail/i }),
      "ana@globo.com",
    );
    await userEvent.type(screen.getByLabelText(/^senha$/i), "Senha123");
    await userEvent.click(screen.getByRole("button", { name: /^entrar$/i }));

    expect(fetch).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith("/visao-geral");
  });

  it("shows a simple error and clears the password after a failed login", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://operacional.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: "UNAUTHENTICATED" } }),
            { status: 401 },
          ),
      ),
    );
    await renderLoginForm();

    await userEvent.type(
      screen.getByRole("textbox", { name: /e-mail/i }),
      "ana@globo.com",
    );
    const password = screen.getByLabelText(/^senha$/i);
    await userEvent.type(password, "errada");
    await userEvent.click(screen.getByRole("button", { name: /^entrar$/i }));

    expect(
      await screen.findByText("E-mail ou senha incorretos."),
    ).toBeInTheDocument();
    expect(password).toHaveValue("");
    expect(push).not.toHaveBeenCalled();
  });

  it("opens the dashboard without a request in demo mode", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_ALLOW_EXAMPLE_DATA", "true");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await renderLoginForm();
    await userEvent.type(
      screen.getByRole("textbox", { name: /e-mail/i }),
      "ana@globo.com",
    );
    await userEvent.type(screen.getByLabelText(/^senha$/i), "Senha123");
    await userEvent.click(screen.getByRole("button", { name: /^entrar$/i }));

    expect(push).toHaveBeenCalledWith("/visao-geral");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns to the original internal page after a renewed login", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://operacional.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: {}, meta: {} }), {
            status: 200,
          }),
      ),
    );
    await renderLoginForm("/dados/importacoes/?origem=menu#historico");

    await userEvent.type(
      screen.getByRole("textbox", { name: /e-mail/i }),
      "ana@globo.com",
    );
    await userEvent.type(screen.getByLabelText(/^senha$/i), "Senha123");
    await userEvent.click(screen.getByRole("button", { name: /^entrar$/i }));

    expect(push).toHaveBeenCalledWith(
      "/dados/importacoes/?origem=menu#historico",
    );
  });

  it("never navigates to an external return address", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://operacional.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: {}, meta: {} }), {
            status: 200,
          }),
      ),
    );
    await renderLoginForm("//malicioso.test/roubar-sessao");

    await userEvent.type(
      screen.getByRole("textbox", { name: /e-mail/i }),
      "ana@globo.com",
    );
    await userEvent.type(screen.getByLabelText(/^senha$/i), "Senha123");
    await userEvent.click(screen.getByRole("button", { name: /^entrar$/i }));

    expect(push).toHaveBeenCalledWith("/visao-geral");
  });
});
