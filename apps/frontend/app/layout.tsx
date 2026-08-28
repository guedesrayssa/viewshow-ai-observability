/**
 * layout.tsx
 * Layout raiz da aplicação.
 *
 * Define o idioma, carrega a tipografia da marca (Poppins), importa os tokens
 * do design system e resolve o tema antes da primeira pintura. Todo o restante
 * da interface é montado a partir daqui.
 */

import type { Metadata, Viewport } from "next";
import { Poppins } from "next/font/google";

import { AccountProvider } from "@/components/account/account-provider";
import { InlineScript } from "@/components/inline-script";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { THEME_BOOTSTRAP_SCRIPT } from "@/lib/theme";

import "./globals.css";

/**
 * Poppins é a tipografia definida na prancha "Foundations" do Figma.
 * Os quatro pesos correspondem aos estilos documentados: Regular, Medium,
 * SemiBold e Bold. O `next/font` baixa e hospeda os arquivos junto da
 * aplicação, sem requisição a CDN externa em tempo de execução.
 */
const poppins = Poppins({
  variable: "--font-poppins",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "View Show",
    template: "%s · View Show",
  },
  description:
    "Plataforma de telemetria de frontend do Globoplay: diagnóstico de falhas de reprodução em minutos.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f7fb" },
    { media: "(prefers-color-scheme: dark)", color: "#060c22" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // `data-theme` nasce claro e é corrigido pelo script abaixo ainda durante
    // a leitura do HTML; `suppressHydrationWarning` faz o React aceitar o valor
    // que já está no documento em vez de reverter para o do servidor.
    <html
      lang="pt-BR"
      data-theme="light"
      suppressHydrationWarning
      className={`${poppins.variable} h-full antialiased`}
    >
      <head>
        <InlineScript html={THEME_BOOTSTRAP_SCRIPT} />
      </head>
      <body className="min-h-full flex flex-col">
        <ThemeProvider>
          <AccountProvider>{children}</AccountProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
