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
  it("offers only one federated action without credential controls or requests", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://operacional.test");
    const fetch = vi.fn();
    const assign = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("window", {
      location: { origin: "http://dashboard.test", assign },
    });

    await renderLoginForm();

    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.queryByRole("textbox", { name: /e-mail/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/senha/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /criar conta/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /esqueceu a senha/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /entrar com sso globo/i }));

    expect(assign).toHaveBeenCalledWith("http://operacional.test/auth/login");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("navigates to the dashboard instead of making an authentication request in demo mode", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_ALLOW_EXAMPLE_DATA", "true");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await renderLoginForm();
    await userEvent.click(screen.getByRole("button", { name: /entrar com sso globo/i }));

    expect(push).toHaveBeenCalledWith("/visao-geral");
    expect(fetch).not.toHaveBeenCalled();
  });
});
