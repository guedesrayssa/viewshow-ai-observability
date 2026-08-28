import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * O painel é inteiramente client-side: não há middleware, route handler nem
   * componente de servidor que busque dados. Exportar como HTML estático evita
   * pagar por um runtime de servidor que nada usaria e permite publicar no
   * Amplify pelo envio de um zip, único caminho possível aqui porque o Amplify
   * não conecta em GitLab auto-hospedado.
   */
  output: "export",

  /**
   * Faz a exportação emitir `login/index.html` em vez de `login.html`.
   *
   * Sem isso, abrir `/login` direto ou recarregar a página devolve 404 no
   * Amplify, e seria preciso compensar com regras de reescrita no console: uma
   * configuração que vive fora do repositório e some quando o app é recriado.
   */
  trailingSlash: true,

  /**
   * A otimização de imagens do Next depende de um servidor, que a exportação
   * estática não tem. Sem esta linha o build falha ao encontrar o primeiro
   * `next/image`.
   */
  images: { unoptimized: true },
};

export default nextConfig;
