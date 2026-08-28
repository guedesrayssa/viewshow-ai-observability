# Camada de dados

> Parte da [documentação do frontend](../documentacao-frontend.md). Este documento
> detalha como um número chega à tela; a visão geral está na seção 5 do índice.

Nenhuma tela do painel lê `fetch` diretamente nem importa medição de um módulo de
exemplo: tudo passa por `lib/data/client.ts` e chega ao componente pelo
`useResource`.

```text
componente (*-view.tsx)
   │  useResource((rev) => fetchX(query, rev), [deps], { refreshMs })
   ▼
fetchX  (em <rota>-resource.ts)
   │  loadResource({ path, params, map, fallback })
   ▼
lib/data/client.ts
   ├─ API configurada (NEXT_PUBLIC_API_BASE_URL)?
   │     ├─ sim  → apiGet(path, params) → map(resposta)  → source: "api"
   │     └─ erro / timeout / 4xx-5xx    → fallback()      → source: "exemplo"
   └─ não → fallback()                                    → source: "exemplo"
```

A tela declara **o que** quer; a camada decide **de onde** vem. Trocar a fonte
não toca em nenhum componente.

## `lib/data/client.ts`

- **`isApiConfigured(): boolean`** — `true` quando `NEXT_PUBLIC_API_BASE_URL` não
  está vazia.
- **`apiGet<T>(path, params?): Promise<T>`** — leitura na API com corpo já
  convertido de JSON. Timeout de **8 s** (`AbortController`); `cache: "no-store"`
  (o painel mostra o estado agora, não um número de cache); lança `ApiError`
  (com `status?: number`) quando a API não está configurada, demora demais ou
  responde fora de 2xx.
- **`loadResource<TResponse, TData>({ path, params?, map, fallback })`** — o ponto
  de integração de cada bloco de tela:

  | Campo | O que é |
  | --- | --- |
  | `path` | Caminho do endpoint (use `ENDPOINTS.*`). |
  | `params` | `Record<string, string \| number \| undefined>`. Chaves `undefined` são omitidas da query. |
  | `map` | Converte a resposta da API no formato que a tela desenha. |
  | `fallback` | Conjunto de exemplo, usado quando a API não responde. |

  Devolve `Resource<T>`:

  ```ts
  type Resource<T> = {
    data: T;
    source: "api" | "exemplo";
    fetchedAt: Date;          // para o rótulo "atualizado há…"
    fallbackReason?: string;  // motivo da queda para o exemplo, quando houve
  };
  ```

  Nunca rejeita: falha de API vira `source: "exemplo"` com `fallbackReason`.

- **`jitter(value, seed, amplitude = 0.06): number`** — oscila um valor de exemplo
  de forma **determinística** (a mesma leitura devolve sempre o mesmo número).
  Serve para uma atualização sem API ainda mostrar movimento, em vez de repetir o
  mesmo quadro. O selo "Dados de exemplo" fica visível o tempo todo.

## `lib/data/endpoints.ts`

`ENDPOINTS` reúne os caminhos publicados pela API, espelhando os controllers de
`apps/basica/backend/`.

| Chave | Caminho | Serve |
| --- | --- | --- |
| `realtimeOverview` | `/v1/analytics/realtime/overview` | CCU, volume de eventos, taxa de erros do recorte |
| `realtimeAlerts` | `/v1/analytics/realtime/alerts` | Alertas e anomalias ativos |
| `qoeMetrics` | `/v1/analytics/qoe/metrics` | VST, rebuffer rate, bitrate médio |
| `qoeTimeseries` | `/v1/analytics/qoe/timeseries` | Série temporal de qualidade de experiência |
| `errorsSummary` | `/v1/analytics/errors/summary` | Resumo de erros e sessões sem falha |
| `errorsTop` | `/v1/analytics/errors/top` | Códigos de erro mais frequentes |
| `errorDetails(code)` | `/v1/analytics/errors/{code}/details` | Detalhe de um código |
| `breakdownDevices` | `/v1/analytics/breakdown/devices` | Segmentação por dispositivo/SO/versão |
| `breakdownNetwork` | `/v1/analytics/breakdown/network` | Segmentação por ISP/CDN/conexão |
| `rcaModules` | `/v1/analytics/rca/modules-breakdown` | Saúde dos módulos (causa provável) |
| `rcaTopology` | `/v1/analytics/rca/topology-health` | Saúde da topologia de processamento |
| `rcaFingerprints` | `/v1/analytics/rca/fingerprints` | Assinaturas de falha agrupadas |
| `rcaCorrelations` | `/v1/analytics/rca/correlations` | Correlações entre mudanças e degradações |

`ApiWindow`: `"5m" | "15m" | "30m" | "1h" | "6h" | "24h"`.

> Alguns `*-resource.ts` ainda apontam para o endpoint mais próximo disponível
> (Eventos usa `rcaFingerprints`, por exemplo). Ao ligar o backend, ajuste `path`
> e `map` para a rota definitiva.

## O hook `useResource`

```ts
const overview = useResource(
  (revision) => fetchOverview(toQuery(filters), revision),
  [filters.timeRange, filters.device, filters.region, filters.appVersion],
  { refreshMs: 30_000 },
);
```

| Parâmetro | Tipo | Papel |
| --- | --- | --- |
| `load` | `(revision: number) => Promise<Resource<T>>` | Função de leitura. Recebe a revisão, para o exemplo variar entre atualizações. |
| `deps` | `readonly unknown[]` | Ao mudar, dispara nova leitura (filtros, período, recorte). |
| `options.refreshMs` | `number` | Intervalo de releitura automática. |
| `options.enabled` | `boolean` (padrão `true`) | Desliga a leitura para dependências que ainda não estão prontas. |

Retorno (`UseResourceResult<T>`): `data?`, `status` (`"loading" | "ready" |
"error"`), `refreshing` (releitura com o dado anterior na tela), `error?`,
`source?`, `fetchedAt?`, `fallbackReason?`, `revision` (semente do exemplo),
`refresh()`.

Detalhes: a função `load` é guardada em `ref` para não virar laço; `refreshing`
só liga quando já houve um dado antes (primeira carga cai no `Skeleton`); a
releitura automática é um `setInterval` que incrementa `revision`.

## Os quatro estados

| Estado | Condição | O que aparece |
| --- | --- | --- |
| **Esperando** | `status === "loading"` sem dado anterior | `Skeleton` do tamanho exato do conteúdo (evita CLS). |
| **Com dado** | `status === "ready"` | O conteúdo, com números contando até o valor lido (`AnimatedNumber`). |
| **Atualizando** | `refreshing === true` | O dado anterior, com "atualizando…" no `DataStatus`. |
| **Sem leitura** | `status === "error"` | `Alert tone="critical"` explicando a falha, com a ação de atualizar. |

Padrão nas `*-view.tsx`:

```tsx
{resource.status === "error" ? (
  <Alert tone="critical" title="Não foi possível ler a telemetria">
    {resource.error} Tente atualizar em alguns instantes.
  </Alert>
) : null}

{data ? <Conteudo {...data} /> : <ConteudoSkeleton />}
```

## `*-resource.ts` e `*-data.ts`

**`<rota>-data.ts`** — tipos do dado que a tela desenha; rótulos e mapas de
metadados (`PERIOD_LABELS`, `URGENCY_META`, `SORT_LABELS`…); opções de filtro; o
**conjunto de exemplo** com valores **numéricos** (é a tela que formata, e é isso
que permite animar a contagem); funções puras de apoio (`sortIncidents`,
`aggregateKpis`).

**`<rota>-resource.ts`** — um tipo `*Response` por endpoint (deixa o formato do
backend explícito); uma função `fetch*` por bloco chamando `loadResource`. O
`fallback` costuma aplicar `jitter` nas medições que oscilam e deixar intactos os
campos que **identificam** o registro (id, nome da fonte, cobertura).

## `DataStatus`: procedência visível

`components/dashboard/data-status.tsx` diz três coisas em texto:

| Situação | Selo |
| --- | --- |
| `error` | `Leitura falhou` (crítico, `role="status"`) |
| `source === "api"` | `Telemetria ao vivo` (sucesso) |
| `source === "exemplo"` | `Dados de exemplo` (atenção) |
| sem `source` ainda | `Lendo telemetria` (neutro) |

Mais o rótulo "atualizado há X" (recalculado a cada 15 s) e o botão de atualizar.
`showSource={false}` esconde o selo onde o cabeçalho já identifica o incidente —
a falha de leitura continua sendo anunciada. **Um número na tela nunca se
apresenta como medição quando não é.**

## Ligar o backend / criar um recurso

Para ligar: preencha `NEXT_PUBLIC_API_BASE_URL`; em cada `*-resource.ts` confira
`path` e escreva o `map` com o formato real da resposta. Nenhum componente muda.

Para criar um recurso: (1) declare o tipo e um exemplo numérico em
`<rota>-data.ts`; (2) escreva `fetchX(query, revision = 0)` com `loadResource` em
`<rota>-resource.ts`; (3) consuma com `useResource` na `*-view.tsx`; (4) desenhe
os quatro estados; (5) ponha `<DataStatus>` no `PageHeader`.
