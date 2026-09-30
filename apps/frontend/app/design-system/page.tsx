/**
 * page.tsx
 * Guia vivo do design system.
 *
 * Renderiza os tokens e os componentes com o mesmo código usado nas telas, de
 * modo que o guia nunca fique desatualizado em relação à implementação. É a
 * referência para quem for construir as próximas telas do View Show.
 *
 * Fica fora do build de produção: a rota não passa pela checagem de sessão
 * do painel e não é tela de produto. Para publicá-la numa demonstração, basta
 * ligar `NEXT_PUBLIC_SHOW_DESIGN_SYSTEM=true`.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { Alert } from "@/components/ui/alert";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { PasswordField, SearchInput, TextField } from "@/components/ui/input";
import { Logo, LogoMark } from "@/components/ui/logo";
import { Skeleton, SkeletonText } from "@/components/ui/skeleton";
import { Wordmark } from "@/components/ui/wordmark";
import { ThemeChoice } from "@/components/theme/theme-toggle";
import { Reveal } from "@/components/motion/reveal";
import { AnimatedNumber } from "@/components/motion/animated-number";
import { SelectPreview } from "@/app/design-system/select-preview";
import { SwitchPreview } from "@/app/design-system/switch-preview";

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

const SHOW_DESIGN_SYSTEM =
  process.env.NODE_ENV !== "production" ||
  process.env.NEXT_PUBLIC_SHOW_DESIGN_SYSTEM === "true";

export default function DesignSystemPage() {
  if (!SHOW_DESIGN_SYSTEM) notFound();

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
          description="Poppins em quatro pesos. O token de tamanho já embute entrelinha e peso, então text-h1 basta para um título. Os títulos encolheram mais do que o texto corrido: em um painel, é o título que ocupa espaço sem carregar dado."
        >
          <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-6">
            <p className="text-display text-ink">Display 32 / 700</p>
            <p className="text-h1 text-ink">Título H1 26 / 700</p>
            <p className="text-h2 text-ink">Título H2 20 / 600</p>
            <p className="text-h3 text-ink">Título H3 17 / 600</p>
            <p className="text-title text-ink">Title 15 / 600</p>
            <p className="text-body text-ink">Body 14 / 400</p>
            <p className="text-body-sm text-ink-muted">Body small 13 / 400</p>
            <p className="text-label text-ink-muted">Label 12 / 500</p>
            <p className="text-caption text-ink-subtle">Caption 11 / 400</p>
            <p className="text-micro text-ink-subtle">Micro 10 / 400</p>
          </div>
        </Section>

        <Section
          title="Raios e sombras"
          description="Raio de 14 px agrupa conteúdo em cartões; 10 px vale para campos e botões. A sombra separa o cartão do fundo sem precisar de borda pesada."
        >
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
            {[
              { label: "rounded-field", extra: "10 px" },
              { label: "rounded-card", extra: "14 px" },
              { label: "rounded-panel", extra: "20 px" },
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
          description="Uma ação primária por área de decisão. O gradiente marca a ação principal; o azul sólido, ações de navegação; contorno e texto, alternativas; danger, o que destrói."
        >
          <div className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface p-6">
            <Button variant="gradient">Ver detalhes</Button>
            <Button variant="solid">Confirmar</Button>
            <Button variant="outline">Refutar</Button>
            <Button variant="ghost">Expandir</Button>
            <Button variant="quiet">Cancelar</Button>
            <Button variant="danger">Excluir</Button>
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

          <SelectPreview />
        </Section>

        <Section
          title="Barra de filtros"
          description="Busca e seletores compactos (fieldSize sm), para filtrar listas e painéis sem ocupar a altura de um formulário."
        >
          <div className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface p-6">
            <SearchInput aria-label="Buscar" placeholder="Buscar" />
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

          <Card borderTone="critical" className="flex items-center justify-between gap-4">
            <div>
              <CardTitle>Zona de risco</CardTitle>
              <p className="mt-1 text-body-sm text-ink-muted">
                Borda `critical`, sem faixa de destaque: reserva para ações
                irreversíveis, como excluir a conta.
              </p>
            </div>
            <Button variant="danger">Excluir conta</Button>
          </Card>
        </Section>

        <Section
          title="Retrato e alternância"
          description="Avatar é o espaço reservado até haver uma foto. Switch troca de estado imediatamente, sem depender de um botão de salvar."
        >
          <div className="flex items-center gap-4 rounded-card border border-line bg-surface p-6">
            <Avatar size="md" />
            <Avatar size="lg" />
          </div>

          <SwitchPreview />
        </Section>

        <Section
          title="Aparência"
          description="Claro, escuro e sistema. O tema escuro reescreve apenas os tokens semânticos, então nenhum componente precisa saber em qual dos dois está."
        >
          <div className="flex flex-col gap-5 rounded-card border border-line bg-surface p-6">
            <ThemeChoice className="self-start" />
            <p className="max-w-2xl text-body-sm text-ink-muted">
              A troca vale para toda a interface e é resolvida antes da primeira
              pintura, por um script no <code>&lt;head&gt;</code>. Textos azuis
              usam <code>ink-brand</code>, que clareia no escuro;{" "}
              <code>brand-blue</code> fica reservado a preenchimento.
            </p>
          </div>
        </Section>

        <Section
          title="Movimento"
          description="Entrada de conteúdo, crescimento de barra, desenho de série e contagem de número. Cada peça se move porque o movimento carrega informação — não como enfeite."
        >
          <div className="grid gap-5 sm:grid-cols-3">
            <Reveal className="rounded-card border border-line bg-surface p-6">
              <p className="text-caption text-ink-subtle">animate-rise</p>
              <p className="mt-2 text-body-sm text-ink">
                Entrada de bloco. Todo conteúdo chega assim, em cascata de 70 ms.
              </p>
            </Reveal>

            <div className="rounded-card border border-line bg-surface p-6">
              <p className="text-caption text-ink-subtle">bar-grow</p>
              <div className="mt-4 flex h-20 items-end gap-2">
                {[40, 72, 55, 96].map((height, index) => (
                  <div
                    key={height}
                    className="bar-grow w-6 rounded-t-[0.75rem] bg-gradient-brand"
                    style={{
                      height: `${height}%`,
                      animationDelay: `${index * 60}ms`,
                    }}
                  />
                ))}
              </div>
            </div>

            <div className="rounded-card border border-line bg-surface p-6">
              <p className="text-caption text-ink-subtle">AnimatedNumber</p>
              <p className="mt-4 text-h1 text-ink">
                <AnimatedNumber value={12400} />
              </p>
              <p className="text-caption text-ink-muted">sessões afetadas</p>
            </div>
          </div>

          <div className="rounded-card border border-line bg-surface p-6">
            <p className="text-caption text-ink-subtle">skeleton</p>
            <div className="mt-4 flex items-center gap-4">
              <Skeleton className="h-12 w-12 rounded-pill" />
              <SkeletonText lines={3} className="flex-1" />
            </div>
            <p className="mt-4 text-body-sm text-ink-muted">
              Ocupa o tamanho exato do conteúdo que vem, para que a chegada do
              dado não empurre a página.
            </p>
          </div>
        </Section>

        <Section
          title="Marca"
          description="Três aplicações do símbolo, conforme o manual, e o letreiro em SVG que substitui a palavra escrita em Poppins."
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

          <div className="grid gap-5 sm:grid-cols-2">
            <div className="flex flex-col items-center gap-4 rounded-card border border-line bg-surface p-8 text-ink">
              <Wordmark height={40} />
              <p className="text-caption text-ink-subtle">
                Letreiro sobre superfície clara
              </p>
            </div>
            <div className="flex flex-col items-center gap-4 rounded-card bg-gradient-navy p-8 text-ink-inverse">
              <Logo tone="gradient" size={48} />
              <p className="text-caption text-gray-400">
                Marca completa sobre o navy da navegação
              </p>
            </div>
          </div>
        </Section>
      </div>
    </div>
  );
}
