import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPatch: vi.fn(),
}));

vi.mock("@/lib/data/client", () => client);

import { ArgusSyncCard } from "@/components/settings/argus-sync-card";
import { ENDPOINTS } from "@/lib/data/endpoints";

const meta = {
  requestId: "req_argus",
  schemaVersion: "1.0",
  datasetVersion: null,
  generatedAt: "2026-01-01T00:00:00Z",
  window: null,
  partial: false,
  refreshAfterSeconds: null,
  freshness: [],
  warnings: [],
};

describe("ArgusSyncCard", () => {
  beforeEach(() => {
    client.apiGet.mockReset();
    client.apiPatch.mockReset();
  });

  it("waits for the confirmed PATCH response before changing the switch", async () => {
    let resolvePatch: (value: {
      data: { enabled: boolean };
      meta: typeof meta;
    }) => void;
    const patch = new Promise<{
      data: { enabled: boolean };
      meta: typeof meta;
    }>((resolve) => {
      resolvePatch = resolve;
    });
    client.apiGet.mockResolvedValue({ data: { enabled: false }, meta });
    client.apiPatch.mockReturnValue(patch);
    const user = userEvent.setup();

    render(<ArgusSyncCard />);

    const toggle = screen.getByRole("switch", {
      name: "Sincronização com o ARGUS",
    });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("aria-checked", "false");

    await waitFor(() => expect(toggle).not.toBeDisabled());
    await user.click(toggle);

    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("aria-checked", "false");

    resolvePatch!({ data: { enabled: true }, meta });

    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(toggle).not.toBeDisabled();
  });

  it("retries a failed GET and renders the confirmed state", async () => {
    client.apiGet
      .mockRejectedValueOnce(
        new Error("Não foi possível carregar a sincronização."),
      )
      .mockResolvedValueOnce({ data: { enabled: true }, meta });
    const user = userEvent.setup();

    render(<ArgusSyncCard />);

    const toggle = screen.getByRole("switch", {
      name: "Sincronização com o ARGUS",
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Não foi possível carregar a sincronização.",
    );
    expect(screen.getByText("Estado: indisponível")).toBeInTheDocument();
    expect(toggle).toBeDisabled();
    await user.click(toggle);
    expect(client.apiPatch).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));

    await waitFor(() => expect(client.apiGet).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByText("Estado: ligada")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("retries a failed PATCH with the same requested value and waits for confirmation", async () => {
    let resolveRetry: (value: {
      data: { enabled: boolean };
      meta: typeof meta;
    }) => void;
    const retryPatch = new Promise<{
      data: { enabled: boolean };
      meta: typeof meta;
    }>((resolve) => {
      resolveRetry = resolve;
    });
    client.apiGet.mockResolvedValue({ data: { enabled: false }, meta });
    client.apiPatch
      .mockRejectedValueOnce(
        new Error("Não foi possível alterar a sincronização."),
      )
      .mockReturnValueOnce(retryPatch);
    const user = userEvent.setup();

    render(<ArgusSyncCard />);

    const toggle = screen.getByRole("switch", {
      name: "Sincronização com o ARGUS",
    });
    await waitFor(() => expect(toggle).not.toBeDisabled());
    await user.click(toggle);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Não foi possível alterar a sincronização.",
    );
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));

    expect(client.apiPatch).toHaveBeenNthCalledWith(
      1,
      ENDPOINTS.argusIntegration,
      { enabled: true },
    );
    expect(client.apiPatch).toHaveBeenNthCalledWith(
      2,
      ENDPOINTS.argusIntegration,
      { enabled: true },
    );
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("aria-checked", "false");

    resolveRetry!({ data: { enabled: true }, meta });

    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(toggle).not.toBeDisabled();
  });
});
