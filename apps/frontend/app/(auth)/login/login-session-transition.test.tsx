import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
  useSearchParams: () => new URLSearchParams(),
}));

describe("login session transition", () => {
  afterEach(() => {
    navigation.push.mockReset();
    navigation.replace.mockReset();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("keeps the renewed session available to the panel guard after login", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://operacional.test");
    let authenticated = false;
    const initialSessionResponses: Array<(response: Response) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/auth/login")) {
          authenticated = true;
          return new Response(JSON.stringify({ data: {}, meta: {} }), { status: 200 });
        }
        if (url.endsWith("/auth/session")) {
          if (!authenticated) {
            return new Promise<Response>((resolve) => {
              initialSessionResponses.push(resolve);
            });
          }
          return new Response(
            JSON.stringify({
              data: {
                user: {
                  id: "user_ana",
                  name: "Ana",
                  email: "ana@globo.com",
                  role: "viewer",
                  issuedAt: "2026-09-25T13:46:02.000Z",
                },
              },
              meta: {},
            }),
            { status: 200 },
          );
        }
        return new Response("", { status: 404 });
      }),
    );
    const [{ default: LoginPage }, { AccountProvider }, { PanelGuard }] =
      await Promise.all([
        import("@/app/(auth)/login/page"),
        import("@/components/account/account-provider"),
        import("@/components/shell/panel-guard"),
      ]);

    function Application() {
      const [route, setRoute] = useState("/login");

      useEffect(() => {
        navigation.push.mockImplementation((destination: string) => {
          setRoute(destination);
        });
        return () => navigation.push.mockReset();
      }, []);

      return (
        <AccountProvider>
          {route === "/login" ? (
            <LoginPage />
          ) : (
            <PanelGuard>
              <p>Visão Geral</p>
            </PanelGuard>
          )}
        </AccountProvider>
      );
    }

    render(<Application />);
    await waitFor(() => expect(initialSessionResponses.length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const resolve of initialSessionResponses) {
      resolve(new Response("", { status: 401 }));
    }
    await userEvent.type(screen.getByRole("textbox", { name: /e-mail/i }), "ana@globo.com");
    await userEvent.type(screen.getByLabelText(/^senha$/i), "Senha123");
    await userEvent.click(screen.getByRole("button", { name: /^entrar$/i }));

    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/visao-geral"));
    expect(await screen.findByText("Visão Geral")).toBeInTheDocument();
    expect(navigation.replace).not.toHaveBeenCalled();
  });
});
