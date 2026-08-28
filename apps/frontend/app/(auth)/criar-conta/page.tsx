/**
 * page.tsx
 * Tela de criação de conta do View Show.
 *
 * Abre com a mesma identidade da tela de login — símbolo, letreiro e título —
 * para que os dois caminhos de entrada sejam lidos como a mesma porta. O
 * formulário fica em componente próprio porque precisa de estado no cliente.
 */

import type { Metadata } from "next";

import { RegisterForm } from "@/app/(auth)/criar-conta/register-form";
import { LogoMark } from "@/components/ui/logo";
import { Wordmark } from "@/components/ui/wordmark";

export const metadata: Metadata = {
  title: "Criar conta",
  description:
    "Crie a sua conta no View Show para acompanhar a telemetria de frontend do Globoplay.",
};

export default function CriarContaPage() {
  return (
    <div className="flex flex-col items-center">
      <LogoMark tone="gradient" size={112} className="animate-scale-in" />

      <Wordmark height={30} animated className="mt-5 text-ink" />

      <h1
        className="mt-6 animate-rise text-h1 text-ink"
        style={{ animationDelay: "760ms" }}
      >
        Criar conta
      </h1>

      <RegisterForm className="mt-8 w-full animate-rise" />
    </div>
  );
}
