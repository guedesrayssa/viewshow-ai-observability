import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

afterEach(() => {
  push.mockReset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.stubGlobal("ResizeObserver", NoopObserver);
  vi.stubGlobal("IntersectionObserver", NoopObserver);
  vi.resetModules();
});

async function renderLoginForm() {
  const { LoginForm } = await import("./login-form");
  return render(<LoginForm />);
}

describe("LoginForm", () => {
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
});
