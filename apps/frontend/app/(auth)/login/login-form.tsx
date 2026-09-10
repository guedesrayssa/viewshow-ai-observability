/**
 * @file login-form.tsx
 * Entrada federada para a conta corporativa.
 */

"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DiamondIcon } from "@/components/ui/icons";
import { beginAuthentication } from "@/lib/auth";
import { cn } from "@/lib/cn";

export function LoginForm({ className }: { className?: string }) {
  const router = useRouter();
  const [formError, setFormError] = useState<string>();

  function handleAuthentication() {
    const decision = beginAuthentication();
    if (decision.kind === "redirect") {
      window.location.assign(decision.url);
      return;
    }
    if (decision.kind === "demo") {
      router.push("/visao-geral");
      return;
    }
    setFormError(decision.message);
  }

  return (
    <div className={cn("flex flex-col gap-6", className)}>
      {formError ? <Alert tone="critical">{formError}</Alert> : null}

      <div className="flex flex-col items-center gap-3">
        <Button
          type="button"
          variant="outline"
          fullWidth
          leadingIcon={<DiamondIcon size={16} />}
          onClick={handleAuthentication}
        >
          Entrar com SSO Globo
        </Button>

        <p className="text-center text-caption text-ink-muted">
          Você será direcionada para a autenticação corporativa Globo.
        </p>
      </div>
    </div>
  );
}
