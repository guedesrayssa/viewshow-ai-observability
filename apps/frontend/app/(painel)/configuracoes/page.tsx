/**
 * page.tsx
 * Tela de Configurações: conta, notificações e acesso corporativo
 * (reprodução da prancha "06 Protótipo - Configurações").
 *
 * Abre com o mesmo cabeçalho das demais telas do painel e revela os cartões em
 * cascata, na ordem em que eles seriam percorridos: quem é a pessoa, o que ela
 * quer ser avisada, por onde ela entra e o que pode encerrar.
 *
 * A escolha de aparência não mora mais aqui: ela já é uma ação da barra
 * superior, ao alcance de qualquer tela, e ter o mesmo controle em dois
 * lugares só dividia a atenção.
 */

import type { Metadata } from "next";
import { PageHeader } from "@/components/dashboard/page-header";
import { Reveal } from "@/components/motion/reveal";
import { AccessSecurityCard } from "@/components/settings/access-security-card";
import { AccountDetailsCard } from "@/components/settings/account-details-card";
import { DangerZoneCard } from "@/components/settings/danger-zone-card";
import { NotificationsCard } from "@/components/settings/notifications-card";
import { ProfileCard } from "@/components/settings/profile-card";

export const metadata: Metadata = {
  title: "Configurações",
  description: "Conta corporativa, notificações e acesso.",
};

export default function ConfiguracoesPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Configurações" />

      <Reveal delay={80}>
        <ProfileCard />
      </Reveal>

      <div className="flex flex-col gap-6 lg:flex-row lg:items-stretch">
        <Reveal delay={140} className="flex flex-1">
          <AccountDetailsCard />
        </Reveal>
        <Reveal delay={200} className="flex flex-1">
          <NotificationsCard />
        </Reveal>
      </div>

      <Reveal delay={260}>
        <AccessSecurityCard />
      </Reveal>

      <Reveal delay={320}>
        <DangerZoneCard />
      </Reveal>
    </div>
  );
}
