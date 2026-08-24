/**
 * page.tsx
 * Guia vivo do design system.
 *
 * Renderiza os tokens e os componentes com o mesmo código usado nas telas, de
 * modo que o guia nunca fique desatualizado em relação à implementação. É a
 * referência para quem for construir as próximas telas do View Show.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { PasswordField, TextField } from "@/components/ui/input";
import { Logo, LogoMark } from "@/components/ui/logo";
import { Select } from "@/components/ui/select";

export const metadata: Metadata = {
  title: "Design system",
  description:
    "Tokens, componentes e regras de uso da interface do View Show.",
};

/** Amostra de cor com nome do token e valor. */
function Swatch({
  name,
  value,
  className,
}: {
  name: string;
  value: string;
  className: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div
        className={`h-20 rounded-card border border-line ${className}`}
        aria-hidden="true"
      />
      <div>
        <p className="text-caption font-medium text-ink">{name}</p>
        <p className="text-micro text-ink-subtle uppercase">{value}</p>
      </div>
    </div>
  );
}

/** Seção do guia, com título e descrição do critério de uso. */
function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-5">
      <div>
        <h2 className="text-h2 text-ink">{title}</h2>
        <p className="mt-1 max-w-2xl text-body-sm text-ink-muted">
          {description}
        </p>
      </div>
      {children}
    </section>
  );
}

export default function DesignSystemPage() {
  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-16">
      <header className="flex flex-col gap-4">
        <Logo tone="gradient" size={40} />
        <h1 className="text-display text-ink">Design system</h1>
        <p className="max-w-2xl text-body text-ink-muted">
          Tokens e componentes do View Show, derivados da prancha
          &ldquo;Foundations&rdquo; do Figma. Toda tela nova deve ser montada a
          partir daqui: se algo não existe neste guia, o caminho é acrescentar
          ao design system, não improvisar na tela.
        </p>
      </header>

      <div className="mt-14 flex flex-col gap-14">
        <Section
          title="Cores de marca"
          description="Azul e navy sustentam a estrutura da interface. Laranja e vermelho ficam reservados a ações primárias e a estados de atenção, para que o destaque não perca força."
        >
          <div className="grid grid-cols-2 gap-5 rounded-card border border-line bg-surface p-6 sm:grid-cols-3 lg:grid-cols-5">
            <Swatch name="brand-blue" value="#0D47D9" className="bg-brand-blue" />
            <Swatch name="brand-navy" value="#101B46" className="bg-brand-navy" />
            <Swatch
              name="brand-orange"
              value="#FF6A32"
              className="bg-brand-orange"
            />
            <Swatch name="brand-red" value="#F43F4E" className="bg-brand-red" />
            <Swatch
              name="gradient-brand"
              value="laranja para vermelho"
              className="bg-gradient-brand"
            />
          </div>
        </Section>

        <Section
          title="Superfícies, texto e bordas"
          description="Tokens semânticos. Use o nome do papel, e não o da cor: assim uma futura versão escura da interface troca apenas os valores neste arquivo."
        >
          <div className="grid grid-cols-2 gap-5 rounded-card border border-line bg-surface p-6 sm:grid-cols-4">
            <Swatch name="canvas" value="#F5F7FB" className="bg-canvas" />
            <Swatch name="surface" value="#FFFFFF" className="bg-surface" />
            <Swatch
              name="surface-inverse"
              value="#101B46"
              className="bg-surface-inverse"
            />
            <Swatch name="line" value="#E6EAF0" className="bg-line" />
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <Card padding="lg">
              <p className="text-h3 text-ink">Diagnóstico em minutos</p>
              <p className="mt-2 text-body-sm text-ink-muted">
                Contexto técnico com hierarquia.
              </p>
              <p className="mt-1 text-caption text-ink-subtle">
                Atualizado há 12 s
              </p>
            </Card>

            <div className="rounded-card bg-surface-inverse p-6">
              <p className="text-h3 text-ink-inverse">Contraste sobre navy</p>
              <p className="mt-2 text-body-sm text-gray-300">
                Uso em navegação e destaques.
              </p>
              <p className="mt-1 text-caption text-gray-400">
                Nunca para grandes áreas de leitura
              </p>
            </div>
          </div>
        </Section>

        <Section
          title="Estados"
          description="Cada estado tem cor e texto. A cor sozinha não comunica: o rótulo textual acompanha sempre, conforme as WCAG 2.2."
        >
          <div className="flex flex-wrap gap-3">
            <Badge tone="critical" withDot>
              Crítico
            </Badge>
            <Badge tone="warning" withDot>
              Atenção
            </Badge>
            <Badge tone="info" withDot>
              Ativo
            </Badge>
            <Badge tone="success" withDot>
              Estável
            </Badge>
            <Badge tone="neutral">Normalizado</Badge>
            <Badge tone="brand">78% de confiança</Badge>
          </div>
        </Section>

        <Section
          title="Tipografia"
          description="Poppins em quatro pesos. O token de tamanho já embute entrelinha e peso, então text-h1 basta para um título."
        >
          <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-6">
            <p className="text-display text-ink">Display 40 / 700</p>
            <p className="text-h1 text-ink">Título H1 32 / 700</p>
            <p className="text-h2 text-ink">Título H2 24 / 600</p>
            <p className="text-h3 text-ink">Título H3 20 / 600</p>
            <p className="text-title text-ink">Title 16 / 600</p>
            <p className="text-body text-ink">Body 15 / 400</p>
            <p className="text-body-sm text-ink-muted">Body small 14 / 400</p>
            <p className="text-label text-ink-muted">Label 13 / 500</p>
            <p className="text-caption text-ink-subtle">Caption 12 / 400</p>
            <p className="text-micro text-ink-subtle">Micro 11 / 400</p>
          </div>
        </Section>

        <Section
          title="Raios e sombras"
          description="Raio de 16 px agrupa conteúdo em cartões; 12 px vale para campos e botões. A sombra separa o cartão do fundo sem precisar de borda pesada."
        >
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
            {[
              { label: "rounded-field", extra: "12 px" },
              { label: "rounded-card", extra: "16 px" },
              { label: "rounded-panel", extra: "24 px" },
              { label: "rounded-pill", extra: "circular" },
            ].map((radius) => (
              <div
                key={radius.label}
                className={`flex h-24 flex-col items-center justify-center border border-line bg-surface shadow-card ${radius.label}`}
              >
                <p className="text-caption font-medium text-ink">
                  {radius.label}
                </p>
                <p className="text-micro text-ink-subtle">{radius.extra}</p>
              </div>
            ))}
          </div>
        </Section>

        <Section
          title="Botões"
          description="Uma ação primária por área de decisão. O gradiente marca a ação principal; o azul sólido, ações de navegação; contorno e texto, alternativas."
        >
          <div className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface p-6">
            <Button variant="gradient">Ver detalhes</Button>
            <Button variant="solid">Confirmar</Button>
            <Button variant="outline">Refutar</Button>
            <Button variant="ghost">Expandir</Button>
            <Button variant="quiet">Cancelar</Button>
            <Button variant="gradient" loading>
              Enviando
            </Button>
            <Button variant="gradient" disabled>
              Indisponível
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface p-6">
            <Button variant="solid" size="sm">
              Pequeno
            </Button>
            <Button variant="solid" size="md">
              Médio
            </Button>
            <Button variant="solid" size="lg">
              Grande
            </Button>
          </div>
        </Section>

        <Section
          title="Campos"
          description="O rótulo fica sempre visível, acima do campo. Placeholder não substitui rótulo. O erro aparece abaixo, em texto, e marca o campo com aria-invalid."
        >
          <div className="grid gap-6 rounded-card border border-line bg-surface p-6 sm:grid-cols-2">
            <TextField
              label="E-mail"
              type="email"
              placeholder="nome@globo.com"
              hint="Use a sua conta corporativa."
            />
            <TextField
              label="E-mail"
              type="email"
              defaultValue="nome@gmail.com"
              error="O acesso é restrito a contas @globo.com."
            />
            <PasswordField label="Senha" placeholder="Digite a sua senha" />
            <TextField
              label="Componente"
              fieldSize="sm"
              placeholder="Filtro compacto"
              hint="Altura sm: filtros e barras de busca."
            />
          </div>

          <div className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface p-6">
            <Select aria-label="Período" defaultValue="30min">
              <option value="30min">Últimos 30 min</option>
              <option value="1h">Última hora</option>
            </Select>
            <Select aria-label="Urgência" defaultValue="all">
              <option value="all">Todas as urgências</option>
              <option value="p1">P1 Crítico</option>
            </Select>
          </div>
        </Section>

        <Section
          title="Cartões e avisos"
          description="Cartão é a superfície de agrupamento. A faixa lateral colorida indica a severidade do indicador que ele apresenta."
        >
          <div className="grid gap-5 sm:grid-cols-3">
            <Card accent="critical">
              <CardDescription>Taxa de erros</CardDescription>
              <CardTitle className="mt-1 text-h2">342/min</CardTitle>
              <p className="mt-1 text-caption text-critical-strong">+18% vs. base</p>
            </Card>
            <Card accent="warning">
              <CardDescription>Latência p95</CardDescription>
              <CardTitle className="mt-1 text-h2">310 ms</CardTitle>
              <p className="mt-1 text-caption text-warning-strong">+6% vs. base</p>
            </Card>
            <Card accent="info">
              <CardDescription>Sessões afetadas</CardDescription>
              <CardTitle className="mt-1 text-h2">12,4 mil</CardTitle>
              <p className="mt-1 text-caption text-ink-muted">
                2,8% do recorte
              </p>
            </Card>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Alert tone="critical">
              Não foi possível entrar. Verifique as credenciais.
            </Alert>
            <Alert tone="warning">
              A fonte CDN está atrasada em 4 minutos.
            </Alert>
            <Alert tone="success">Hipótese confirmada e encaminhada.</Alert>
            <Alert tone="info">
              O acesso é restrito a contas corporativas.
            </Alert>
          </div>
        </Section>

        <Section
          title="Marca"
          description="Três aplicações, conforme o manual: principal sobre fundo claro, gradiente para superfícies de destaque e monocromática quando não há cor disponível."
        >
          <div className="grid gap-5 sm:grid-cols-3">
            <div className="flex flex-col items-center gap-4 rounded-card border border-line bg-surface p-8">
              <LogoMark tone="brand" size={72} />
              <p className="text-caption text-ink-subtle">Principal</p>
            </div>
            <div className="flex flex-col items-center gap-4 rounded-card bg-surface-inverse p-8">
              <LogoMark tone="gradient" size={72} />
              <p className="text-caption text-gray-400">Gradiente</p>
            </div>
            <div className="flex flex-col items-center gap-4 rounded-card border border-line bg-surface p-8">
              <LogoMark tone="mono" size={72} />
              <p className="text-caption text-ink-subtle">Monocromática</p>
            </div>
          </div>
        </Section>
      </div>
    </div>
  );
}
