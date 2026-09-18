/**
 * page.tsx
 * Ajuda para recuperar o acesso.
 *
 * A autenticação é controlada pelo provedor corporativo de identidade. A tela
 * existe para orientar a pessoa e devolvê-la ao login sem chamar a API.
 */

import type { Metadata } from "next";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { LogoMark } from "@/components/ui/logo";
import { Wordmark } from "@/components/ui/wordmark";

export const metadata: Metadata = {
  title: "Recuperar acesso",
  description: "Como recuperar o acesso à conta usada no View Show.",
};

export default function RecuperarSenhaPage() {
  return (
    <div className="flex flex-col items-center">
      <LogoMark tone="gradient" size={88} className="animate-scale-in" />

      <Wordmark height={24} className="mt-4 animate-rise-sm text-ink" />

      <h1 className="mt-6 animate-rise text-h2 text-ink">Recuperar acesso</h1>

      <p className="mt-3 text-center text-body-sm text-ink-muted">
        Se você não consegue entrar, o suporte interno pode ajudar a
        recuperar o acesso à sua conta.
      </p>

      <Alert tone="info" className="mt-8 w-full">
        Procure o suporte interno de TI para recuperar ou desbloquear a conta.
        Depois disso, volte e entre normalmente.
      </Alert>

      <Link
        href="/login"
        className="mt-8 rounded-field text-body-sm font-medium text-ink-brand underline-offset-4 hover:underline"
      >
        Voltar para o login
      </Link>
    </div>
  );
}
