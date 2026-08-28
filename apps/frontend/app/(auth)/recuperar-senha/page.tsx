/**
 * page.tsx
 * Recuperação de senha.
 *
 * A senha pertence ao provedor corporativo de identidade (RESTR01): a
 * plataforma não a armazena nem a redefine. A tela existe para explicar isso
 * e devolver a pessoa ao login sem deixá-la sem saída.
 */

import type { Metadata } from "next";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { LogoMark } from "@/components/ui/logo";
import { Wordmark } from "@/components/ui/wordmark";

export const metadata: Metadata = {
  title: "Recuperar senha",
  description:
    "Como recuperar o acesso à conta corporativa usada no View Show.",
};

export default function RecuperarSenhaPage() {
  return (
    <div className="flex flex-col items-center">
      <LogoMark tone="gradient" size={88} className="animate-scale-in" />

      <Wordmark height={24} className="mt-4 animate-rise-sm text-ink" />

      <h1 className="mt-6 animate-rise text-h2 text-ink">Recuperar senha</h1>

      <p className="mt-3 text-center text-body-sm text-ink-muted">
        O View Show usa a sua conta corporativa Globo. A troca de senha é feita
        no portal de identidade da empresa, e não aqui.
      </p>

      <Alert tone="info" className="mt-8 w-full">
        Procure o suporte interno de TI para redefinir a senha ou desbloquear a
        conta. Depois disso, volte e entre normalmente.
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
