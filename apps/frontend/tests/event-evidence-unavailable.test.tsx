import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EventsChart } from "@/app/(painel)/incidentes/_eventos/events-chart";
import { BufferingChart } from "@/app/(painel)/incidentes/detalhe/buffering-chart";

describe("ARGUS unavailable aggregates", () => {
  it("does not leave the Event chart in an endless loading state", () => {
    render(
      <EventsChart
        status="error"
        error="O agregado temporal de eventos ainda não está disponível."
        period="30"
        onPeriodChange={vi.fn()}
      />,
    );

    expect(screen.getByText("Volume indisponível")).toBeInTheDocument();
  });

  it("does not leave the Evidence chart in an endless loading state", () => {
    render(
      <BufferingChart
        status="error"
        error="A série de buffering não está disponível para este incidente."
        marker={null}
        period="120"
        onPeriodChange={vi.fn()}
      />,
    );

    expect(screen.getByText("Série indisponível")).toBeInTheDocument();
  });
});
