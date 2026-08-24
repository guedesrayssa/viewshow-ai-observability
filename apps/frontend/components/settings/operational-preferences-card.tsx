"use client";

import { useState } from "react";
import { Card, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { DEFAULT_PERIOD_OPTIONS, INITIAL_SCREEN_OPTIONS } from "@/lib/settings-data";

export function OperationalPreferencesCard() {
  const [period, setPeriod] = useState(DEFAULT_PERIOD_OPTIONS[1].value);
  const [initialScreen, setInitialScreen] = useState(
    INITIAL_SCREEN_OPTIONS[0].value,
  );

  return (
    <Card className="flex flex-1 flex-col">
      <CardTitle>Preferências operacionais</CardTitle>

      <div className="mt-5 flex flex-1 flex-col gap-5">
        <div className="flex flex-col gap-2">
          <label className="block text-label text-ink-muted">
            Período padrão
          </label>
          <Select
            aria-label="Período padrão"
            fieldSize="md"
            value={period}
            onChange={(event) => setPeriod(event.target.value)}
            className="w-full"
          >
            {DEFAULT_PERIOD_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex flex-col gap-2">
          <label className="block text-label text-ink-muted">
            Tela inicial após entrar
          </label>
          <Select
            aria-label="Tela inicial após entrar"
            fieldSize="md"
            value={initialScreen}
            onChange={(event) => setInitialScreen(event.target.value)}
            className="w-full"
          >
            {INITIAL_SCREEN_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <p className="mt-5 text-caption text-brand-blue">
        Valores e horários seguem o fuso de Brasília.
      </p>
    </Card>
  );
}
