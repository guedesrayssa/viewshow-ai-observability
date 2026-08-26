"use client";

import { useState } from "react";
import { Card, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import {
  DEFAULT_PERIOD_OPTIONS,
  INITIAL_SCREEN_OPTIONS,
} from "@/lib/settings-data";

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
          <label className="block text-label text-ink-muted">Período padrão</label>
          <Select
            aria-label="Período padrão"
            fieldSize="md"
            value={period}
            onValueChange={setPeriod}
            className="w-full"
            options={DEFAULT_PERIOD_OPTIONS}
          />
        </div>

        <div className="flex flex-col gap-2">
          <label className="block text-label text-ink-muted">
            Tela inicial após entrar
          </label>
          <Select
            aria-label="Tela inicial após entrar"
            fieldSize="md"
            value={initialScreen}
            onValueChange={setInitialScreen}
            className="w-full"
            options={INITIAL_SCREEN_OPTIONS}
          />
        </div>
      </div>

      <p className="mt-5 text-caption text-ink-brand">
        Valores e horários seguem o fuso de Brasília.
      </p>
    </Card>
  );
}
