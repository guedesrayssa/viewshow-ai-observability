# Testes da API de Telemetria

Registro da verificação funcional dos endpoints da API v1, feita por requisições
HTTP a partir de um cliente gráfico. O objetivo é comprovar, com evidência, que
os contratos descritos em [`backend.md`](backend.md) se comportam como
especificado, tanto no caminho feliz quanto na recusa de entrada inválida.

## Sumário

1. [Escopo](#1-escopo)
2. [Ambiente de execução](#2-ambiente-de-execução)
3. [Pré-condições](#3-pré-condições)
4. [Como reproduzir](#4-como-reproduzir)
5. [Casos de teste](#5-casos-de-teste)
6. [Evidências](#6-evidências)
7. [Resultado da execução](#7-resultado-da-execução)
8. [Limitações conhecidas](#8-limitações-conhecidas)

---

## 1. Escopo

Estão cobertos os dois grupos de endpoints da API v1:

| Família | Endpoints | O que é verificado |
| --- | --- | --- |
| Ingestão (`POST`) | `/v1/telemetry/events`, `/errors`, `/heartbeat` | aceite de lote, aceite parcial, recusa total, corpo malformado |
| Consulta (`GET`) | `/v1/analytics/errors/*`, `/v1/analytics/qoe/*` | agregações, ordenação, consistência interna e validação de parâmetros |

Ficam **fora** deste artefato os testes automatizados de unidade e integração,
que rodam por `pytest` em `apps/basica/backend/tests/` e cobrem o domínio sem
passar pela camada HTTP. Os dois se complementam: o `pytest` prova a regra de
negócio, este documento prova o contrato exposto na rede.

---

## 2. Ambiente de execução

| Item | Valor |
| --- | --- |
| Cliente | Insomnia 13.1.0 |
| Coleção | `artefatos/postman/telemetria-globoplay.postman_collection.json` (formato Postman v2.1, importado) |
| Ambiente | `local` (`baseUrl = http://localhost:5000`) |
| Janela consultada | `window = 24h` |
| Backend de armazenamento | `memory` |
| Data da execução | 14/08/2026 |

A coleção está no formato do Postman porque o Insomnia importa esse formato
nativamente, inclusive os scripts de verificação. Isso mantém um único conjunto
de casos para os dois clientes e para a execução em linha de comando.

> **Nota sobre a contagem de asserções.** O contador do Insomnia (`Tests 8/8`,
> por exemplo) soma asserções individuais, enquanto a coluna "Verificações" da
> tabela abaixo conta blocos `pm.test` da coleção. Os dois números não coincidem
> para a mesma requisição, e isso é esperado.

---

## 3. Pré-condições

1. **API no ar** em `http://localhost:5000`.
2. **Base semeada** com a massa de demonstração. As consultas do grupo 2 agregam
   dados da janela: com a base vazia elas respondem `200` normalmente, só que com
   listas vazias, e as verificações falham por um motivo que não é óbvio na tela.
3. **Massa dentro da janela de 24 h.** A retenção descarta registros mais antigos,
   então uma semeadura de ontem não sustenta uma execução de hoje.

---

## 4. Como reproduzir

### 4.1 Preparar

```bash
cd apps/basica/backend
.venv/bin/python wsgi.py                                      # em um terminal
.venv/bin/python scripts/seed_demo.py --base-url http://localhost:5000
```

O `wsgi.py` é o ponto de entrada e sobe em `127.0.0.1:5000` por padrão. Em
produção quem serve é o gunicorn (`gunicorn -w 3 wsgi:app`), não o servidor
embutido. Nesse caso o armazenamento precisa ser o `dynamodb`, porque cada
worker teria a própria base em memória.

### 4.2 Importar no cliente

No Insomnia, **Create → Import → From File**, e selecione a coleção e o ambiente:

```
artefatos/postman/telemetria-globoplay.postman_collection.json
artefatos/postman/local.postman_environment.json
```

### 4.3 Executar

Rode os grupos **na ordem `1 → 2 → 3 → 4`**. A coleção é encadeada em dois
pontos, e requisição solta fora de ordem falha:

| Origem | Variável | Consumidor |
| --- | --- | --- |
| `2.2 Ranking dos erros` (script de resposta) | `codigoTopo` | `2.3 Detalhe de um código de erro` |
| `4.1 Enviar erro com código único` (script de pré-requisição) | `codigoE2E` | `4.2 Localizar o erro no ranking` |

### 4.4 Alternativa em linha de comando

Para um número reproduzível, sem depender de captura de tela:

```bash
npx newman run artefatos/postman/telemetria-globoplay.postman_collection.json \
    -e artefatos/postman/local.postman_environment.json
```

---

## 5. Casos de teste

São 17 requisições e 59 verificações. A coluna "Esperado" traz o status HTTP e a
condição principal; as demais verificações de cada caso estão nos scripts da
própria coleção.

### 5.1 Ingestão

| ID | Requisição | Método | Entrada | Esperado | Verif. |
| --- | --- | --- | --- | --- | --- |
| 1.1 | Enviar lote de eventos de reprodução | `POST /v1/telemetry/events` | 2 eventos válidos | `202`, `accepted=2`, `rejected=[]`, `resource="events"` | 4 |
| 1.2 | Registrar um erro de reprodução | `POST /v1/telemetry/errors` | 1 erro fatal `DNS_RESOLVE_FAIL` | `202`, `accepted=1` | 2 |
| 1.3 | Registrar presença de sessão | `POST /v1/telemetry/heartbeat` | 2 sessões | `202`, `accepted=2` | 2 |
| 1.4 | Lote parcialmente inválido | `POST /v1/telemetry/errors` | 1 válido + 1 sem `session_id` | `202`, `accepted=1`, `rejected[0].index=1` com motivo citando `session_id` | 3 |
| 1.5 | Lote totalmente inválido | `POST /v1/telemetry/errors` | 1 item sem `session_id` | `422`, `error.code="unprocessable_payload"`, `details` com 1 item | 4 |
| 1.6 | Corpo malformado | `POST /v1/telemetry/events` | string JSON solta | `400`, `error.code="validation_error"` | 3 |

O caso **1.4** é o mais relevante do grupo: comprova que um item ruim não derruba
o lote inteiro, e que a resposta aponta *qual* item falhou e *por quê*. Sem esse
comportamento, um cliente com um bug em um único campo perderia toda a telemetria
boa enviada junto.

### 5.2 Consultas

| ID | Requisição | Método | Esperado | Verif. |
| --- | --- | --- | --- | --- |
| 2.1 | Resumo de erros da janela | `GET /v1/analytics/errors/summary` | `200`, `window.duration_seconds=86400`, 7 indicadores presentes | 6 |
| 2.2 | Ranking dos erros mais frequentes | `GET /v1/analytics/errors/top?limit=5` | `200`, no máximo 5 itens, ordenado por ocorrências decrescentes | 6 |
| 2.3 | Detalhe de um código de erro | `GET /v1/analytics/errors/{codigo}/details` | `200`, soma da `timeline` igual a `occurrences` | 4 |
| 2.4 | Métricas de qualidade de experiência | `GET /v1/analytics/qoe/metrics` | `200`, percentis de tempo de início presentes | 5 |
| 2.5 | Série temporal de qualidade | `GET /v1/analytics/qoe/timeseries` | `200`, intervalos sem amostra com métricas nulas | 5 |

A verificação de **2.3** é uma checagem de consistência interna: a soma dos
pontos da linha do tempo tem de bater com o total de ocorrências do mesmo
retorno. É o tipo de erro de agregação que um teste de status HTTP não pegaria.

### 5.3 Erros de consulta

| ID | Requisição | Parâmetro | Esperado | Verif. |
| --- | --- | --- | --- | --- |
| 3.1 | Código de erro inexistente | `CODIGO_INEXISTENTE` | `404`, `error.code="not_found"` | 3 |
| 3.2 | Janela em formato inválido | `window=ontem` | `400`, mensagem com exemplo válido | 3 |
| 3.3 | Limite fora do intervalo | `limit=999` | `400` (teto de 200) | 2 |
| 3.4 | Janela acima do máximo | `window=60d` | `400` (teto de 30 dias) | 2 |

Os casos **3.3** e **3.4** verificam limites que existem para proteger o banco:
cada janela vira uma consulta por bucket de tempo, e um `limit` sem teto
permitiria arrastar a base inteira em uma resposta.

A distinção testada em **3.1** também é deliberada: um código sem ocorrências
devolve `404`, não uma resposta vazia. Para quem investiga uma falha, "não
existe" e "existe e está zerado" são conclusões diferentes.

### 5.4 Ponta a ponta

| ID | Requisição | Método | Esperado | Verif. |
| --- | --- | --- | --- | --- |
| 4.1 | Enviar erro com código único | `POST /v1/telemetry/errors` | `202`; gera `codigoE2E` inédito | 2 |
| 4.2 | Localizar o erro no ranking | `GET /v1/analytics/errors/top?limit=200` | `200`; o código aparece com 1 ocorrência, fatal, módulo `player` | 3 |

O código é gerado com `Date.now()` a cada execução justamente para que o teste
não possa passar por causa de dados deixados por uma rodada anterior.

---

## 6. Evidências

### 6.1 Ingestão de lote: `202 ACCEPTED`

![Requisição 1.1 no Insomnia: POST de lote de eventos respondendo 202 com accepted=2](../assets/testes/teste-1-1-ingestao-lote-eventos.png)

Caso 1.1. Resposta em 154 ms, 62 B: `accepted: 2`, `received: 2`, `rejected: []`,
`resource: "events"`. Contador do Insomnia em `6/6`.

### 6.2 Resumo de erros: `200 OK`

![Requisição 2.1 no Insomnia: GET do resumo de erros respondendo 200 com os indicadores agregados](../assets/testes/teste-2-1-resumo-erros-janela.png)

Caso 2.1. Resposta em 1,14 s, 274 B, com a janela de 86 400 s e os indicadores
agregados: 101 erros totais, 51 fatais, 6 códigos distintos, 101 sessões
afetadas de 180, taxa de erro 0,2405 e taxa de sessões sem falha 0,7167.
Contador em `8/8`.

### 6.3 Código de erro inexistente: `404 NOT FOUND`

![Requisição 3.1 no Insomnia: GET de código inexistente respondendo 404 com envelope de erro](../assets/testes/teste-3-1-codigo-inexistente-404.png)

Caso 3.1. Resposta em 82 ms, 131 B, com o envelope padrão de erro:
`code: "not_found"`, `details: []` e mensagem citando o código consultado.
Contador em `5/5`.

### 6.4 Ponta a ponta: falha

![Requisição 4.2 no Insomnia: GET do ranking respondendo 200, com o contador de testes em 3/5 em vermelho](../assets/testes/teste-4-2-ponta-a-ponta-ranking.png)

Caso 4.2. A requisição em si respondeu `200 OK` em 139 ms com o ranking
esperado (`DNS_RESOLVE_FAIL` 34, `PLAYER_TIMEOUT` 23, `DRM_LICENSE_DENIED` 17,
`ANR_MAIN_THREAD` 12), mas o contador ficou em **`3/5`**. As
verificações que falharam são as que dependem de `codigoE2E`, e o código de
ponta a ponta não aparece na resposta.

A causa provável é a ordem de execução: a captura mostra as abas 2.1, 3.1, 1.1
e 4.2 abertas, **sem a 4.1**. O `codigoE2E` é definido pelo script de
pré-requisição de 4.1; sem executá-la antes, 4.2 procura no ranking um código
que nunca foi enviado. Está registrado como pendente na seção 7.

---

## 7. Resultado da execução

| Caso | Status HTTP | Verificações | Resultado |
| --- | --- | --- | --- |
| 1.1 Lote de eventos | `202 ACCEPTED` | 6/6 | ✅ |
| 2.1 Resumo de erros | `200 OK` | 8/8 | ✅ |
| 3.1 Código inexistente | `404 NOT FOUND` | 5/5 | ✅ |
| 4.2 Ponta a ponta | `200 OK` | 3/5 | ❌ |

Os casos sem captura nesta rodada (1.2 a 1.6, 2.2 a 2.5, 3.2 a 3.4 e 4.1) estão
especificados na seção 5 e são executáveis pela coleção, mas **não têm evidência
registrada aqui**. Não são resultados omitidos: são casos ainda não capturados.

### Pendências

| # | Pendência | Ação |
| --- | --- | --- |
| P1 | Caso 4.2 em falha (`3/5`) | Reexecutar o grupo 4 na ordem `4.1 → 4.2` e recapturar |
| P2 | 13 dos 17 casos sem evidência | Capturar, ou anexar a saída do `newman` como evidência única |

A saída do `newman` resolve as duas pendências de uma vez e não depende de
captura manual, e é o caminho recomendado para fechar o relatório.

---

## 8. Limitações conhecidas

- **Execução contra o backend em memória.** Os dados somem quando o processo
  reinicia, e cada worker teria a própria base. A execução contra o DynamoDB
  exercita um caminho de código diferente (`repositories/dynamodb.py`) e ainda
  não foi registrada aqui.
- **Ambiente local apenas.** A coleção traz um ambiente para a EC2, mas esta
  rodada usou apenas `localhost`.
- **Dependência de ordem.** A coleção não é executável em paralelo nem em ordem
  arbitrária, pelo encadeamento descrito em 4.3.
- **Massa com validade de 24 h.** Qualquer reexecução exige semear de novo.
