/**
 * page.tsx
 * Tela de Configurações: conta, aparência, preferências operacionais,
 * notificações e acesso corporativo (reprodução da prancha
 * "06 Protótipo - Configurações").
 *
 * Abre com o mesmo cabeçalho das demais telas do painel e revela os cartões em
 * cascata, na ordem em que eles seriam percorridos: quem é a pessoa, como ela
 * quer ver o painel, o que quer ser avisada e o que pode encerrar.
 */

import type { Metadata } from "next";
import { PageHeader } from "@/components/dashboard/page-header";
import { Reveal } from "@/components/motion/reveal";
import { AccessSecurityCard } from "@/components/settings/access-security-card";
import { AccountDetailsCard } from "@/components/settings/account-details-card";
import { AppearanceCard } from "@/components/settings/appearance-card";
import { DangerZoneCard } from "@/components/settings/danger-zone-card";
import { NotificationsCard } from "@/components/settings/notifications-card";
import { OperationalPreferencesCard } from "@/components/settings/operational-preferences-card";
import { ProfileCard } from "@/components/settings/profile-card";

export const metadata: Metadata = {
  title: "Configurações",
  description:
    "Conta corporativa, aparência do painel, preferências operacionais, notificações e acesso.",
};

export default function ConfiguracoesPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Configurações"
        subtitle="Conta, aparência, notificações e acesso corporativo"
      />

      <Reveal delay={80}>
        <ProfileCard />
      </Reveal>

      <div className="flex flex-col gap-6 lg:flex-row lg:items-stretch">
        <Reveal delay={140} className="flex flex-1">
          <AccountDetailsCard />
        </Reveal>
        <Reveal delay={200} className="flex flex-1">
          <AppearanceCard />
        </Reveal>
      </div>

      <div className="flex flex-col gap-6 lg:flex-row lg:items-stretch">
        <Reveal delay={260} className="flex flex-1">
          <OperationalPreferencesCard />
        </Reveal>
        <Reveal delay={320} className="flex flex-1">
          <NotificationsCard />
        </Reveal>
      </div>

      <Reveal delay={380}>
        <AccessSecurityCard />
      </Reveal>

      <Reveal delay={440}>
        <DangerZoneCard />
      </Reveal>
    </div>
  );
}
