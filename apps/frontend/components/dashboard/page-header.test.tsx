import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PageHeader } from "@/components/dashboard/page-header";

describe("PageHeader", () => {
  it("mantém as ações encostadas à direita quando o cabeçalho quebra linha", () => {
    render(<PageHeader title="Importações" actions={<button>Importar</button>} />);
    expect(screen.getByRole("button", { name: "Importar" }).parentElement).toHaveClass(
      "ml-auto",
    );
  });
});
