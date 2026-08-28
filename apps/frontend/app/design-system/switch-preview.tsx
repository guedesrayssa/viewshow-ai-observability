/**
 * @file switch-preview.tsx
 * Amostra interativa do `Switch` para o guia do design system.
 *
 * Isolado em componente de cliente porque o `Switch` precisa de estado; o
 * restante do guia continua em componente de servidor.
 */

"use client";

import { useState } from "react";
import { Switch } from "@/components/ui/switch";

export function SwitchPreview() {
  const [enabled, setEnabled] = useState(true);
  const [disabled, setDisabled] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-6 rounded-card border border-line bg-surface p-6">
      <div className="flex items-center gap-3">
        <Switch label="Ligado" checked={enabled} onCheckedChange={setEnabled} />
        <span className="text-body-sm text-ink-muted">
          {enabled ? "Ligado" : "Desligado"}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <Switch
          label="Desabilitado"
          checked={disabled}
          onCheckedChange={setDisabled}
          disabled
        />
        <span className="text-body-sm text-ink-muted">Desabilitado</span>
      </div>
    </div>
  );
}
