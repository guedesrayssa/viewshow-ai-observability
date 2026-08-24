/**
 * page.tsx
 * Tela de Configurações: conta, preferências operacionais, notificações e
 * acesso corporativo (reprodução da prancha "06 Protótipo - Configurações").
 */

import type { Metadata } from "next";
import Link from "next/link";

import { ChevronLeftIcon } from "@/components/ui/icons";
import { AccessSecurityCard } from "@/components/settings/access-security-card";
import { AccountDetailsCard } from "@/components/settings/account-details-card";
import { DangerZoneCard } from "@/components/settings/danger-zone-card";
import { NotificationsCard } from "@/components/settings/notifications-card";
import { OperationalPreferencesCard } from "@/components/settings/operational-preferences-card";
import { ProfileCard } from "@/components/settings/profile-card";

export const metadata: Metadata = {
  title: "Configurações",
};

export default function ConfiguracoesPage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start gap-4 pr-28">
        <Link
          href="/visao-geral"
          aria-label="Voltar"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-pill bg-brand-navy text-ink-inverse transition-colors hover:bg-brand-navy-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-blue-light"
        >
          <ChevronLeftIcon size={18} />
        </Link>
        <div>
          <h1 className="text-h1 text-ink">Configurações</h1>
          <p className="mt-1 text-body-sm text-brand-blue">
            Conta, aparência, notificações e acesso corporativo
          </p>
        </div>
      </div>

      <ProfileCard />

      <div className="flex flex-col gap-6 lg:flex-row lg:items-stretch">
        <AccountDetailsCard />
        <OperationalPreferencesCard />
      </div>

      <div className="flex flex-col gap-6 lg:flex-row lg:items-stretch">
        <NotificationsCard />
        <AccessSecurityCard />
      </div>

      <DangerZoneCard />
    </div>
  );
}
