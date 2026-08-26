/**
 * @file login-form.tsx
 * Formulário de acesso por e-mail corporativo e senha.
 *
 * A validação acontece no envio e não a cada tecla: avisar o erro enquanto a
 * pessoa ainda digita interrompe a tarefa sem necessidade. Depois do primeiro
 * envio, o erro de cada campo é limpo assim que o valor muda, para que a
 * correção seja percebida na hora.
 *
 * Qualquer e-mail válido entra. A conta corporativa continua tendo o caminho
 * mais curto — o botão de SSO, que dispensa a senha —, e a interface o sugere
 * assim que reconhece o domínio.
 */

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DiamondIcon } from "@/components/ui/icons";
import { PasswordField, TextField } from "@/components/ui/input";
import {
  AUTH_UNAVAILABLE_MESSAGE,
  CORPORATE_DOMAINS,
  isCorporateEmail,
  signIn,
  ssoEntryPoint,
  validateEmail,
  validatePassword,
} from "@/lib/auth";
import { cn } from "@/lib/cn";

type FieldErrors = {
  email?: string;
  password?: string;
};

export function LoginForm({ className }: { className?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(undefined);

    const errors: FieldErrors = {
      email: validateEmail(email),
      password: validatePassword(password),
    };
    setFieldErrors(errors);

    // Levar o foco ao primeiro campo inválido evita que a pessoa precise
    // procurar na tela o que impediu o envio.
    if (errors.email) {
      emailRef.current?.focus();
      return;
    }
    if (errors.password) {
      passwordRef.current?.focus();
      return;
    }

    setSubmitting(true);
    const result = await signIn({ email, password });
    setSubmitting(false);

    if (!result.ok) {
      setFormError(result.message);
      return;
    }

    // Visão Geral é o hub do fluxo depois da autenticação (seção 6 do UX).
    router.push("/visao-geral");
  }

  /**
   * Entrada por SSO corporativo. Sem provedor configurado, a ação explica a
   * indisponibilidade em vez de ficar desabilitada sem justificativa na tela.
   */
  function handleSso() {
    const ssoUrl = ssoEntryPoint();

    if (!ssoUrl) {
      setFormError(AUTH_UNAVAILABLE_MESSAGE);
      return;
    }

    window.location.assign(ssoUrl);
  }

  return (
    <form
      // A validação nativa do navegador é desligada para que as mensagens
      // sigam o texto e o estilo do design system.
      noValidate
      onSubmit={handleSubmit}
      className={cn("flex flex-col gap-6", className)}
    >
      {formError ? <Alert tone="critical">{formError}</Alert> : null}

      <TextField
        ref={emailRef}
        label="E-mail"
        name="email"
        type="email"
        inputMode="email"
        autoComplete="email"
        placeholder={`nome@${CORPORATE_DOMAINS[0]}`}
        hint="E-mail corporativo ou da equipe parceira"
        value={email}
        error={fieldErrors.email}
        onChange={(event) => {
          setEmail(event.target.value);
          if (fieldErrors.email) {
            setFieldErrors((current) => ({ ...current, email: undefined }));
          }
        }}
      />

      <PasswordField
        ref={passwordRef}
        label="Senha"
        name="password"
        autoComplete="current-password"
        placeholder="Digite a sua senha"
        value={password}
        error={fieldErrors.password}
        onChange={(event) => {
          setPassword(event.target.value);
          if (fieldErrors.password) {
            setFieldErrors((current) => ({ ...current, password: undefined }));
          }
        }}
      />

      <div className="mt-2 flex flex-col items-center gap-4">
        <Button type="submit" variant="gradient" fullWidth loading={submitting}>
          Entrar
        </Button>

        <Link
          href="/recuperar-senha"
          className="rounded-field text-body-sm text-ink-muted underline-offset-4 hover:text-ink hover:underline"
        >
          Esqueceu a senha?
        </Link>
      </div>

      {/* A divisória separa os dois caminhos de entrada, para que o SSO não
          pareça uma segunda etapa do formulário acima. */}
      <div className="flex items-center gap-3" aria-hidden="true">
        <span className="h-px flex-1 bg-line" />
        <span className="text-caption text-ink-subtle">ou</span>
        <span className="h-px flex-1 bg-line" />
      </div>

      <div className="flex flex-col items-center gap-3">
        <Button
          variant="outline"
          fullWidth
          leadingIcon={<DiamondIcon size={16} />}
          onClick={handleSso}
        >
          Entrar com SSO Globo
        </Button>

        <p className="text-center text-caption text-ink-muted">
          {isCorporateEmail(email)
            ? "Conta Globo: o SSO entra sem pedir senha."
            : `Contas @${CORPORATE_DOMAINS[0]} podem entrar direto pelo SSO.`}
        </p>
        <p className="text-center text-micro text-ink-muted">
          Ao continuar, você concorda com as políticas internas de segurança.
        </p>
      </div>
    </form>
  );
}
