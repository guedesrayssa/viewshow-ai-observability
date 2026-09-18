"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { apiGet, apiPatch } from "@/lib/data/client";
import { ENDPOINTS } from "@/lib/data/endpoints";

type RetryAction = "load" | "change" | null;

export function ArgusSyncCard() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryAction, setRetryAction] = useState<RetryAction>(null);
  const [retryEnabled, setRetryEnabled] = useState<boolean | null>(null);

  const loadEnabled = useCallback(async () => {
    try {
      const response = await apiGet<{ enabled: boolean }>(
        ENDPOINTS.argusIntegration,
      );
      setEnabled(response.data.enabled);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Não foi possível carregar a sincronização.",
      );
      setRetryAction("load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(loadEnabled);
  }, [loadEnabled]);

  async function changeEnabled(next: boolean) {
    setSaving(true);
    setError(null);
    setRetryAction(null);
    setRetryEnabled(null);
    try {
      const response = await apiPatch<
        { enabled: boolean },
        { enabled: boolean }
      >(ENDPOINTS.argusIntegration, { enabled: next });
      setEnabled(response.data.enabled);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Não foi possível alterar a sincronização.",
      );
      setRetryAction("change");
      setRetryEnabled(next);
    } finally {
      setSaving(false);
    }
  }

  function retry() {
    if (retryAction === "load") {
      setLoading(true);
      setError(null);
      setRetryAction(null);
      void loadEnabled();
    }
    if (retryAction === "change" && retryEnabled !== null)
      void changeEnabled(retryEnabled);
  }

  return (
    <Card className="flex flex-col">
      <CardTitle>Sincronização com o ARGUS</CardTitle>
      <CardDescription className="mt-1">
        Controle a importação contínua de dados do ARGUS.
      </CardDescription>

      <div className="mt-5 flex items-center justify-between gap-4">
        <div>
          <p className="text-body-sm font-semibold text-ink">
            Sincronização ao vivo
          </p>
          <p className="text-caption text-ink-muted">
            A sincronização já iniciada continuará até terminar.
          </p>
          <p className="text-caption text-ink-muted" aria-live="polite">
            Estado:{" "}
            {enabled === null
              ? loading
                ? "carregando"
                : "indisponível"
              : enabled
                ? "ligada"
                : "desligada"}
          </p>
        </div>
        <Switch
          label="Sincronização com o ARGUS"
          checked={enabled === true}
          disabled={enabled === null || loading || saving}
          onCheckedChange={changeEnabled}
        />
      </div>

      {error ? (
        <div className="mt-4 flex flex-wrap items-center gap-3" role="alert">
          <p className="text-caption text-critical">{error}</p>
          <Button size="sm" variant="outline" onClick={retry}>
            Tentar novamente
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
