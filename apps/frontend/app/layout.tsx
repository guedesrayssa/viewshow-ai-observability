/**
 * layout.tsx
 * Layout raiz da aplicação.
 *
 * Define o idioma, carrega a tipografia da marca (Poppins) e importa os tokens
 * do design system. Todo o restante da interface é montado a partir daqui.
 */

import type { Metadata, Viewport } from "next";
import { Poppins } from "next/font/google";

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
  themeColor: "#101B46",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="pt-BR" className={`${poppins.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
