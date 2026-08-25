/**
 * page.tsx
 * Tela de Eventos do View Show.
 *
 * Permite inspecionar os eventos de telemetria correlacionados a uma
 * degradação e reconstruir seu contexto técnico, conforme a seção 5.5 do
 * entendimento de UX. Materializa principalmente a US-ENG-02 e a US-ENG-03.
 */

import type { Metadata } from "next";

import { EventsView } from "@/app/(painel)/eventos/events-view";

export const metadata: Metadata = {
  title: "Eventos",
  description:
    "Eventos e sessões de telemetria do Globoplay, com o dado normalizado ligado à fonte original, sem perder o registro bruto.",
};

export default function EventosPage() {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-h1 text-ink">Eventos</h1>
        <p className="mt-1 text-body-sm text-brand-blue">
          Eventos e sessões sem perder o dado original
        </p>
      </header>

      <EventsView />
    </div>
  );
}
