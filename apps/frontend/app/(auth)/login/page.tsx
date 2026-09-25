/**
 * page.tsx
 * Tela de login do View Show.
 *
 * Inicia o acesso com um usuário cadastrado no Cognito deste ambiente.
 */

import type { Metadata } from "next";
import { Suspense } from "react";

import { LoginForm } from "@/app/(auth)/login/login-form";
import { LogoMark } from "@/components/ui/logo";
import { Wordmark } from "@/components/ui/wordmark";

export const metadata: Metadata = {
  title: "Entrar",
  description:
    "Acesse o View Show com seu e-mail e senha para acompanhar a telemetria de frontend do Globoplay.",
};

export default function LoginPage() {
  return (
    <div className="flex flex-col items-center">
      {/* A abertura monta a marca em duas partes: o símbolo cresce e o
          letreiro se escreve bloco a bloco. É o único momento de exibição da
          identidade em todo o produto — o painel, depois, é só trabalho. */}
      <LogoMark tone="gradient" size={112} className="animate-scale-in" />

      <Wordmark height={30} animated className="mt-5 text-ink" />

      <h1 className="mt-6 animate-rise text-h1 text-ink" style={{ animationDelay: "760ms" }}>
        Login
      </h1>

      <Suspense fallback={null}>
        <LoginForm className="mt-8 w-full animate-rise" />
      </Suspense>
    </div>
  );
}
