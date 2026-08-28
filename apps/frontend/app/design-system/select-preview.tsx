/**
 * @file select-preview.tsx
 * Demonstração do seletor no guia do design system.
 *
 * O seletor é controlado — quem guarda o valor é a tela —, então o guia
 * precisa de um pedaço de estado próprio para mostrá-lo funcionando.
 */

"use client";

import { useState } from "react";

import { Select } from "@/components/ui/select";

const PERIOD_OPTIONS = [
  { value: "30min", label: "Últimos 30 min" },
  { value: "1h", label: "Última 1 h" },
  { value: "24h", label: "Últimas 24 h" },
];

const URGENCY_OPTIONS = [
  { value: "all", label: "Todas as urgências" },
  { value: "p1", label: "P1 Crítico", hint: "Perda de reprodução em massa" },
  { value: "p2", label: "P2 Alto", hint: "Degradação com contorno" },
  { value: "p3", label: "P3 Médio" },
  { value: "p4", label: "P4 Baixo", disabled: true },
];

/** Dois seletores lado a lado, um deles com texto de apoio nas opções. */
export function SelectPreview() {
  const [period, setPeriod] = useState("30min");
  const [urgency, setUrgency] = useState("all");

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface p-6">
      <Select
        aria-label="Período"
        value={period}
        onValueChange={setPeriod}
        options={PERIOD_OPTIONS}
      />
      <Select
        aria-label="Urgência"
        value={urgency}
        onValueChange={setUrgency}
        options={URGENCY_OPTIONS}
      />
      <Select
        aria-label="Fonte indisponível"
        value="youbora"
        onValueChange={() => {}}
        options={[{ value: "youbora", label: "Fonte: Youbora" }]}
        disabled
      />
    </div>
  );
}
