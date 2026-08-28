/**
 * @file register-form.tsx
 * Formulário de criação de conta.
 *
 * Envia nome, e-mail e senha ao `POST /auth/register` da API operacional. O
 * registro já abre a sessão — o cookie volta na própria resposta —, então o
 * sucesso leva direto à Visão Geral, sem repetir a senha no login.
 *
 * A confirmação de senha é validada só aqui, no navegador: o servidor não
 * precisa dela, e o campo existe para pegar erro de digitação antes de a
 * senha errada virar a senha da conta.
 */

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";

import { useAccount } from "@/components/account/account-provider";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PasswordField, TextField } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import {
  signUp,
  validateEmail,
  validateName,
  validateNewPassword,
} from "@/lib/auth";

type FieldErrors = {
  name?: string;
  email?: string;
  password?: string;
  confirm?: string;
};

export function RegisterForm({ className }: { className?: string }) {
  const router = useRouter();
  const { updateProfile } = useAccount();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  function clearFieldError(field: keyof FieldErrors) {
    setFieldErrors((current) =>
      current[field] ? { ...current, [field]: undefined } : current,
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(undefined);

    const errors: FieldErrors = {
      name: validateName(name),
      email: validateEmail(email),
      password: validateNewPassword(password),
      confirm:
        confirm === password ? undefined : "As duas senhas precisam ser iguais.",
    };
    setFieldErrors(errors);

    // O foco vai para o primeiro campo com problema, na ordem do formulário.
    const focusOrder = [
      ["name", nameRef],
      ["email", emailRef],
      ["password", passwordRef],
      ["confirm", confirmRef],
    ] as const;
    const firstError = focusOrder.find(([field]) => errors[field]);
    if (firstError) {
      firstError[1].current?.focus();
      return;
    }

    setSubmitting(true);
    const result = await signUp({ name, email, password });
    setSubmitting(false);

    if (!result.ok) {
      if (result.field) {
        setFieldErrors((current) => ({ ...current, [result.field!]: undefined }));
        setFieldErrors((current) => ({
          ...current,
          [result.field as keyof FieldErrors]: result.message,
        }));
        (result.field === "email" ? emailRef : passwordRef).current?.focus();
      } else {
        setFormError(result.message);
      }
      return;
    }

    // O nome escolhido passa a assinar o painel na hora — mesma conta que
    // acabou de nascer no servidor.
    updateProfile({ name: result.name });
    router.push("/visao-geral");
  }

  return (
    <form
      noValidate
      onSubmit={handleSubmit}
      className={cn("flex flex-col gap-6", className)}
    >
      {formError ? <Alert tone="critical">{formError}</Alert> : null}

      <TextField
        ref={nameRef}
        label="Nome"
        name="name"
        autoComplete="name"
        placeholder="Como você quer ser identificada"
        hint="Assina as revisões de hipótese que você registrar"
        value={name}
        error={fieldErrors.name}
        onChange={(event) => {
          setName(event.target.value);
          clearFieldError("name");
        }}
      />

      <TextField
        ref={emailRef}
        label="E-mail"
        name="email"
        type="email"
        inputMode="email"
        autoComplete="email"
        placeholder="nome@exemplo.com"
        value={email}
        error={fieldErrors.email}
        onChange={(event) => {
          setEmail(event.target.value);
          clearFieldError("email");
        }}
      />

      <PasswordField
        ref={passwordRef}
        label="Senha"
        name="password"
        autoComplete="new-password"
        placeholder="Pelo menos 8 caracteres"
        value={password}
        error={fieldErrors.password}
        onChange={(event) => {
          setPassword(event.target.value);
          clearFieldError("password");
        }}
      />

      <PasswordField
        ref={confirmRef}
        label="Confirmar senha"
        name="confirm-password"
        autoComplete="new-password"
        placeholder="Repita a senha escolhida"
        value={confirm}
        error={fieldErrors.confirm}
        onChange={(event) => {
          setConfirm(event.target.value);
          clearFieldError("confirm");
        }}
      />

      <div className="mt-2 flex flex-col items-center gap-4">
        <Button type="submit" variant="gradient" fullWidth loading={submitting}>
          Criar conta
        </Button>

        <p className="text-center text-body-sm text-ink-muted">
          Já tem conta?{" "}
          <Link
            href="/login"
            className="rounded-field font-medium text-ink underline-offset-4 hover:underline"
          >
            Entrar
          </Link>
        </p>
      </div>
    </form>
  );
}
