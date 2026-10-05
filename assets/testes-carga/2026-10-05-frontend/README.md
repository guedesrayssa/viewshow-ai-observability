# Evidências de carga do frontend — 05/10/2026

Rodada executada na branch `feat/teste-carga-front`, commit-base
`a89e6b6220d7b2c24714d3a450cf6d1bc0338a60`. A análise está em
[`artefatos/testes-carga-finais.md`](../../../artefatos/testes-carga-finais.md).

## Ambiente

| Item | Valor |
| --- | --- |
| Gerador | Windows 11, Intel Core i5-1345U, 15,7 GiB RAM |
| Runtime | Node.js 24.14.1 |
| Navegador | Chrome 154.0.8037.95 |
| Frontend | Next.js 16.3.1, exportação estática de produção |
| Servidor local | `serve@14`, loopback `127.0.0.1:4173` |
| Carga HTTP | Autocannon 8.0.0, conexão persistente, sem pipelining |
| Auditoria | Lighthouse 12.8.2 |

O build normal tentou Turbopack, mas a política de execução do Windows bloqueou
o módulo SWC nativo. A mesma fonte foi compilada com `next build --webpack`,
alternativa oficial indicada pelo próprio erro, e gerou 21 páginas estáticas.

## Arquivos

| Arquivo | Conteúdo | Estado |
| --- | --- | --- |
| `static-smoke.json` | 2 conexões, 15 s | Aprovado |
| `static-load.json` | 50 conexões, 60 s | Aprovado |
| `static-spike.json` | 200 conexões, 30 s | Resiliente sem erros; reprovou o limite de latência |
| `static-smoke-recovery.json` | repetição smoke imediatamente após o spike | Aprovado; comprova recuperação |
| `static-aws-amplify-smoke.json` | smoke da publicação manual no Amplify | Sem erros; comparativo de infraestrutura, não do código novo |
| `lighthouse-mobile-1..3.json` | três auditorias móveis da exportação atual em `/login/` | RNF07 aprovado para a rota medida |
| `lighthouse-desktop-1..3.json` | três auditorias desktop da exportação atual em `/login/` | RNF07 aprovado para a rota medida |

Os JSONs do Lighthouse são os relatórios integrais, não apenas o resumo. Os
JSONs do Autocannon contêm configuração, mistura de URLs, distribuição de
latência, vazão, códigos HTTP e avaliação dos thresholds.

## Escopo e cautelas

- A carga local mede a exportação estática atual: sete HTMLs e 24 recursos
  versionados descobertos nos próprios documentos.
- O resultado local não mede a capacidade do CDN Amplify nem a API.
- O smoke do Amplify mede a infraestrutura publicada, mas essa publicação é de
  30/09/2026 e não contém as alterações atuais da branch.
- O Lighthouse mede a rota pública `/login/`. As telas autenticadas e os
  gráficos ainda precisam de uma rodada publicada com sessão e dados reais.
