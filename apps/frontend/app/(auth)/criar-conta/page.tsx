/**
 * page.tsx
 * Orienta pessoas sem conta local para a entrada corporativa.
 */

import type { Metadata } from "next";

import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { LogoMark } from "@/components/ui/logo";
import { Wordmark } from "@/components/ui/wordmark";

export const metadata: Metadata = {
  title: "Acesso corporativo",
  description: "Entre no View Show com a sua conta.",
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
        Acesso corporativo
      </h1>

      <Alert tone="info" className="mt-8 w-full animate-rise">
        O acesso ao View Show é feito com a sua conta. Se você precisa de
        acesso, procure o suporte interno de TI.
      </Alert>

      <Link
        href="/login"
        className="mt-8 rounded-field text-body-sm font-medium text-ink-brand underline-offset-4 hover:underline"
      >
        Ir para o login
      </Link>
    </div>
  );
}
