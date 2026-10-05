# Carga da entrega estática do frontend

Este cenário mede os HTMLs exportados e os recursos `/_next/static/` que eles
referenciam. Ele complementa `apps/backend/api/loadtest/k6/front-api.js`, que
mede as chamadas à API geradas pelo painel, e o Lighthouse, que mede renderização
e Web Vitals no navegador.

## Executar

Primeiro gere e sirva a exportação de produção:

```bash
NEXT_PUBLIC_API_BASE_URL=/ npm run build
npx serve out --listen 4173
```

Em outro terminal:

```bash
BASE_URL=http://127.0.0.1:4173 PROFILE=smoke npm run loadtest:static
BASE_URL=http://127.0.0.1:4173 PROFILE=load npm run loadtest:static
BASE_URL=http://127.0.0.1:4173 PROFILE=spike npm run loadtest:static
```

No PowerShell, defina as variáveis com `$env:BASE_URL` e `$env:PROFILE`.
Os resultados vão para `loadtest/results/` por padrão. Para versionar uma
rodada, informe `RESULTS_DIR` apontando para a pasta de evidências.
`RUN_LABEL` permite preservar repetições como `smoke-recovery` sem sobrescrever
o resultado anterior.

## Perfis e critérios

| Perfil | Conexões | Duração |
| --- | ---: | ---: |
| `smoke` | 2 | 15 s |
| `load` | 50 | 60 s |
| `spike` | 200 | 30 s |

A rodada aprova quando não há erro de transporte, timeout ou resposta não 2xx,
e a latência p97,5 permanece abaixo de 200 ms (critério mais rigoroso que p95).
O alvo local isola o peso e a
capacidade da exportação; a URL publicada acrescenta rede e CDN e deve ser
analisada separadamente.
