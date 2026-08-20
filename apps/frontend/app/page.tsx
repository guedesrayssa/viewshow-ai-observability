/**
 * page.tsx
 * Raiz da aplicação.
 *
 * Enquanto a Visão Geral não existe, a raiz encaminha para o login: o acesso à
 * plataforma é restrito e nenhuma tela pública precisa ser servida em `/`.
 */

import { redirect } from "next/navigation";

export default function Home() {
  redirect("/login");
}
