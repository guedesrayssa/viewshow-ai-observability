import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const { push, searchParams } = vi.hoisted(() => ({
  push: vi.fn(),
  searchParams: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => searchParams,
}));

afterEach(() => {
  push.mockReset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("LoginPage", () => {
  it("entrega a rota de retorno da query ao formulário", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://operacional.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const data = url.endsWith("/auth/session")
          ? {
              user: {
                id: "usr_1",
                name: "Ana",
                email: "ana@globo.com",
                role: "engineer",
                issuedAt: "2026-09-24T20:00:00.000Z",
              },
            }
          : {};
        return new Response(JSON.stringify({ data, meta: {} }), { status: 200 });
      }),
    );
    const { default: LoginPage } = await import("./page");
    searchParams.set(
      "returnTo",
      "/dados/importacoes/?origem=menu#historico",
    );
    render(LoginPage());

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
});
