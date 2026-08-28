/**
 * layout.tsx
 * Moldura das telas de acesso (login e recuperação de senha).
 *
 * Reproduz a divisão do protótipo: painel ilustrado à esquerda, em navy com as
 * esferas de marca, e conteúdo à direita sobre superfície branca. Abaixo de
 * `lg` o painel some e o formulário ocupa a tela inteira, porque a ilustração
 * é decorativa e não carrega informação.
 */

import type { ReactNode } from "react";

/**
 * Esferas decorativas do painel, posicionadas como no protótipo do Figma.
 *
 * Cada uma deriva no próprio ritmo. O atraso diferente evita que as quatro
 * subam juntas, o que seria lido como a página inteira se mexendo.
 */
const ORBS = [
  { size: "65%", left: "48%", top: "60%", delay: "0s" },
  { size: "39%", left: "26%", top: "35%", delay: "-6s" },
  { size: "29%", left: "72%", top: "22%", delay: "-11s" },
  { size: "29%", left: "39%", top: "85%", delay: "-3s" },
];

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="grid flex-1 lg:grid-cols-2">
      {/* Ilustração de marca. Sem conteúdo textual, logo oculta de leitores de tela. */}
      <aside
        aria-hidden="true"
        className="relative hidden overflow-hidden bg-gradient-navy lg:block"
      >
        {ORBS.map((orb) => (
          <span
            key={`${orb.left}-${orb.top}`}
            className="absolute aspect-square animate-orb-drift rounded-pill bg-gradient-orb"
            style={{
              width: orb.size,
              left: orb.left,
              top: orb.top,
              animationDelay: orb.delay,
            }}
          />
        ))}
      </aside>

      <div className="flex items-center justify-center bg-surface px-6 py-16 sm:px-10">
        {/* 27,5rem equivale aos 440 px de largura de campo do protótipo. */}
        <div className="w-full max-w-[27.5rem]">{children}</div>
      </div>
    </main>
  );
}
