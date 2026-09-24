/**
 * @file login-form.tsx
 * Entrada com e-mail e senha validados pelo Cognito através do backend.
 */

"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PasswordField, TextField } from "@/components/ui/input";
import { authenticateWithPassword, isDemoModeActive } from "@/lib/auth";
import { cn } from "@/lib/cn";

export function LoginForm({ className }: { className?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(undefined);
    setSubmitting(true);
    try {
      const decision = await authenticateWithPassword(email, password);
      setPassword("");
      if (decision.kind === "authenticated" || decision.kind === "demo") {
        router.push("/visao-geral");
        return;
      }
      setFormError(decision.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className={cn("flex flex-col gap-6", className)}
      onSubmit={handleSubmit}
    >
      {isDemoModeActive() ? (
        <Alert tone="warning">
          Modo de demonstração: qualquer e-mail e senha abrem o painel com
          dado de exemplo.
        </Alert>
      ) : null}

      {formError ? <Alert tone="critical">{formError}</Alert> : null}

      <TextField
        label="E-mail"
        type="email"
        autoComplete="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        required
        disabled={submitting}
      />

      <PasswordField
        label="Senha"
        autoComplete="current-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        required
        disabled={submitting}
      />

      <Button type="submit" fullWidth loading={submitting}>
        Entrar
      </Button>
    </form>
  );
}
