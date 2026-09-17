/**
 * page.tsx
 * Raiz da aplicação.
 *
 * Acesso direto ao painel enquanto a autenticação está fora do fluxo.
 */

import { redirect } from "next/navigation";

export default function Home() {
  redirect("/visao-geral");
}
