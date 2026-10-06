# Evidências de carga do frontend — 05/10/2026

Rodada executada na branch `feat/teste-carga-front`, commit-base
`a89e6b6220d7b2c24714d3a450cf6d1bc0338a60`. A análise está em
[`testes-carga-finais-front.md`](../../../artefatos/sprint5/testes-carga-finais-front.md).

**Histórico:** as cinco auditorias iniciadas entre 21:13:32 e 21:13:34 UTC
se sobrepõem; seus valores não constituem uma referência isolada de LCP/TBT.
O smoke de recuperação usou 2 conexões e começou 19,728 s após o pico.
A revisão e as novas medições sequenciais estão em
[`2026-10-06-frontend`](../2026-10-06-frontend/README.md).

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
| `static-smoke-recovery.json` | smoke de 2 conexões, 19,728 s após o spike | Aprovado nesse escopo; não prova recuperação a 50 conexões |
| `static-aws-amplify-smoke.json` | smoke da publicação manual no Amplify | Sem erros; comparativo de infraestrutura, não do código novo |
| `lighthouse-mobile-1..3.json` | auditorias móveis originais em `/login/` | Histórico; duas coletas concorrentes com desktop |
| `lighthouse-desktop-1..3.json` | auditorias desktop originais em `/login/` | Histórico; coletas concorrentes |

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
