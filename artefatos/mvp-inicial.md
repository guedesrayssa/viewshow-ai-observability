# MVP inicial — relatório de testes

**Grupo 05** — Módulo 7, Engenharia de Software, Inteli
**Parceiro:** Globo
**Sprint 1** — entrega em 14/08/2026

---

## Vídeo da demonstração

**Link:** https://drive.google.com/file/d/1UHMSnINawkYnwnYTzsumoDp44dkHjgqi/view?usp=sharing

O vídeo tem 2 minutos e 4 segundos e percorre o caminho completo: envio de um erro
por `POST` no Postman, consulta da rota de resumo exposta pelo backend na EC2 e
navegação pelo painel publicado como página estática no S3, incluindo o detalhamento
de um dos erros enviados durante a própria gravação.

---

## 1. Ambiente avaliado

A aplicação está implantada em três serviços da AWS, na região `us-east-1`:

| Camada | Serviço | Endereço |
| --- | --- | --- |
| Painel (página estática) | S3 — website hosting | `http://g05-telemetria-front.s3-website-us-east-1.amazonaws.com` |
| API | EC2 `t3.micro`, Amazon Linux 2023 | `http://35.172.27.238` |
| Persistência | DynamoDB, tabela `telemetry` | — |

A API roda sob `gunicorn` com três workers, supervisionada pelo `systemd`
(`telemetria.service`), escutando diretamente na porta 80. A instância acessa o
DynamoDB pela role `LabInstanceProfile`, sem credenciais estáticas em disco.

O roteiro completo de implantação está em [`deploy-aws.md`](deploy-aws.md).

> **Sobre o endereço da API.** O ambiente é um laboratório da AWS Academy, cuja
> sessão encerra após quatro horas e desliga a instância. A instância tem Elastic IP
> e o serviço está habilitado no `systemd`, de modo que ligá-la de novo restaura a
> API no mesmo endereço, sem intervenção. Se o IP mudar em alguma sessão futura,
> basta atualizar o arquivo de ambiente do Postman citado na seção 2.

---

## 2. Como reproduzir os testes

Os testes estão versionados como uma coleção do Postman em
[`postman/`](postman/), com dois arquivos de ambiente:

| Arquivo | `baseUrl` | Uso |
| --- | --- | --- |
| `local.postman_environment.json` | `http://localhost:5000` | Execução na máquina do desenvolvedor |
| `aws.postman_environment.json` | `http://35.172.27.238` | Execução contra a instância EC2 |

**Pela interface do Postman:** importe `telemetria-globoplay.postman_collection.json`
e os dois arquivos de ambiente, selecione o ambiente desejado no seletor do canto
superior direito e use *Run collection*.

**Pela linha de comando:**

```bash
npx newman run artefatos/postman/telemetria-globoplay.postman_collection.json \
    -e artefatos/postman/aws.postman_environment.json
```

A coleção é autossuficiente: as requisições da pasta 1 criam os registros que as
requisições da pasta 2 consultam, então ela passa integralmente mesmo contra uma
base recém-criada e vazia.

---

## 3. Resultado consolidado

| Métrica | Valor |
| --- | --- |
| Requisições executadas | 17 |
| Asserções executadas | 93 |
| Asserções falhas | **0** |
| Scripts de teste | 34 |
| Tempo total da execução | 552 ms |
| Tempo médio de resposta | 6 ms (mín. 3 ms, máx. 27 ms) |

Duas asserções são aplicadas a **todas** as requisições, no nível da coleção:
resposta em menos de 5 segundos e `Content-Type` contendo `application/json`.
As demais 59 são específicas de cada requisição e verificam o conteúdo do corpo.

---

## 4. Testes de requisições POST

Todas as rotas de ingestão aceitam tanto um objeto único quanto uma lista, e
respondem `202 Accepted` com o balanço entre aceitos e recusados.

| # | Requisição | Método e rota | Esperado | Obtido | Resultado |
| --- | --- | --- | --- | --- | --- |
| 1.1 | Enviar lote de eventos de reprodução | `POST /v1/telemetry/events` | 202 | 202, 266 B | Passou |
| 1.2 | Registrar um erro de reprodução | `POST /v1/telemetry/errors` | 202 | 202, 266 B | Passou |
| 1.3 | Registrar presença de sessão | `POST /v1/telemetry/heartbeat` | 202 | 202, 270 B | Passou |
| 1.4 | Lote parcialmente inválido | `POST /v1/telemetry/errors` | 202 com item recusado | 202, 335 B | Passou |
| 1.5 | Lote totalmente inválido | `POST /v1/telemetry/errors` | 422 | 422, 404 B | Passou |
| 1.6 | Corpo malformado | `POST /v1/telemetry/events` | 400 | 400, 403 B | Passou |

### O que cada caso verifica

**1.1 a 1.3** confirmam o caminho normal de ingestão nas três rotas: o corpo
devolvido traz `received` igual ao enviado, `accepted` igual a `received` e
`rejected` vazio.

**1.4 — aceitação parcial.** Um lote com dois erros, sendo o segundo sem
`session_id`. A API aceita o primeiro e recusa o segundo, e o teste verifica que
`rejected[0].index` é `1` — ou seja, que a posição informada corresponde ao item
problemático — e que a justificativa cita o campo ausente. O comportamento é
deliberado: um dispositivo que envia um lote com um registro corrompido não deve
perder os registros válidos do mesmo lote.

**1.5 — nada aproveitável.** Quando *todos* os itens são inválidos, a resposta muda
para `422 unprocessable_payload`. A distinção em relação ao caso anterior importa
para o cliente decidir se reenvia ou descarta.

**1.6 — corpo malformado.** JSON sintaticamente inválido devolve
`400 validation_error`, e não 422: o problema está na requisição em si, antes de
qualquer regra de negócio.

---

## 5. Testes de requisições GET

| # | Requisição | Método e rota | Esperado | Obtido | Resultado |
| --- | --- | --- | --- | --- | --- |
| 2.1 | Resumo de erros da janela | `GET /v1/analytics/errors/summary?window=24h` | 200 | 200, 461 B | Passou |
| 2.2 | Ranking dos erros mais frequentes | `GET /v1/analytics/errors/top?window=24h&limit=5` | 200 | 200, 983 B | Passou |
| 2.3 | Detalhe de um código de erro | `GET /v1/analytics/errors/DNS_RESOLVE_FAIL/details?window=24h` | 200 | 200, 3,64 kB | Passou |
| 2.4 | Métricas de qualidade de experiência | `GET /v1/analytics/qoe/metrics?window=24h` | 200 | 200, 510 B | Passou |
| 2.5 | Série temporal de qualidade | `GET /v1/analytics/qoe/timeseries?window=24h` | 200 | 200, 13,08 kB | Passou |

### O que cada caso verifica

As asserções não se limitam ao código de status: elas checam **coerência interna**
dos dados devolvidos, que é onde uma regressão silenciosa apareceria.

**2.1 — resumo.** Verifica que a janela devolvida tem exatamente 86.400 segundos,
que os sete campos do resumo estão presentes, que o número de erros fatais nunca
excede o total de erros e que as taxas ou estão entre 0 e 1 ou são `null`.

**2.2 — ranking.** Verifica que os itens vêm em ordem decrescente de ocorrências,
que cada item traz os oito campos previstos e que `first_seen` nunca é posterior a
`last_seen`. O código no topo é guardado em variável para a requisição seguinte.

**2.3 — detalhe.** Consulta o código capturado em 2.2 e verifica que a soma das
ocorrências da linha do tempo bate com o total informado — uma agregação que não
fecha indicaria erro no particionamento por intervalo.

**2.4 — QoE.** Verifica que o percentil 95 do tempo de início do vídeo é maior ou
igual à mediana. É uma propriedade que precisa valer para qualquer amostra.

**2.5 — série temporal.** Verifica que a quantidade de pontos corresponde à duração
da janela dividida pelo intervalo, com tolerância de um ponto, e que os pontos estão
em ordem cronológica.

---

## 6. Testes de tratamento de erro

Um relatório que só exercita o caminho feliz não diz nada sobre robustez. Estes
casos confirmam que entradas inválidas produzem respostas úteis, e não erro 500.

| # | Requisição | Rota | Esperado | Obtido | Resultado |
| --- | --- | --- | --- | --- | --- |
| 3.1 | Código de erro inexistente | `GET /v1/analytics/errors/CODIGO_INEXISTENTE/details` | 404 | 404, 337 B | Passou |
| 3.2 | Janela em formato inválido | `GET /v1/analytics/errors/summary?window=ontem` | 400 | 400, 362 B | Passou |
| 3.3 | Limite fora do intervalo | `GET /v1/analytics/errors/top?limit=999` | 400 | 400, 322 B | Passou |
| 3.4 | Janela acima do máximo | `GET /v1/analytics/errors/summary?window=60d` | 400 | 400, 331 B | Passou |

Todas as respostas de erro seguem o mesmo envelope:

```json
{ "error": { "code": "validation_error", "message": "...", "details": {} } }
```

As asserções verificam não só o status, mas que a mensagem **ensina o formato
correto**: a de 3.2 precisa citar um exemplo válido como `15m`, a de 3.3 precisa
informar o intervalo aceito (`entre 1 e 200`) e a de 3.4 precisa dizer qual é o teto
da janela em segundos (`2592000`). Uma mensagem de erro que não permite ao chamador
se corrigir sozinho é uma falha de projeto, e o teste trata como tal.

---

## 7. Teste de ponta a ponta (POST seguido de GET)

Este é o caso que demonstra a integração completa exigida pelo item (1) do artefato:
um dado gravado por `POST` sendo devolvido por um `GET` subsequente.

| # | Requisição | Rota | Obtido | Resultado |
| --- | --- | --- | --- | --- |
| 4.1 | Enviar erro com código único | `POST /v1/telemetry/errors` | 202, 266 B | Passou |
| 4.2 | Localizar o erro no ranking | `GET /v1/analytics/errors/top?window=24h&limit=200` | 200, 1,22 kB | Passou |

O script de pré-requisição gera um código inédito a cada execução, no formato
`TESTE_E2E_<timestamp>`, e o armazena em variável. A requisição 4.2 então verifica
que esse código aparece na consulta com exatamente **uma** ocorrência, **uma**
ocorrência fatal e módulo `player` — os mesmos valores enviados.

O código ser gerado na hora é o ponto central do teste: ele não pode ter vindo da
massa de demonstração nem de uma execução anterior. Se aparece no `GET`, foi o
`POST` desta execução que o criou.

---

## 8. Verificações realizadas diretamente na AWS

Além da coleção, as verificações abaixo foram executadas contra o ambiente
implantado, a partir de uma máquina externa à AWS, em 13 e 14/08/2026.

### 8.1 Disponibilidade da API na EC2

```
GET http://35.172.27.238/v1/analytics/errors/summary?window=24h
→ HTTP 200 em 0,487 s
```

Resposta obtida, com a massa de demonstração carregada:

```json
{"summary":{"affected_sessions":101,"crash_free_rate":0.7167,"error_rate":0.2405,
"fatal_errors":51,"total_errors":101,"total_sessions":180,"unique_error_codes":6},
"window":{"duration_seconds":86400,"end":"2026-08-13T20:26:09Z",
"start":"2026-08-12T20:26:09Z"}}
```

### 8.2 Persistência no DynamoDB

Os três workers do `gunicorn` são processos independentes. Seis chamadas
consecutivas ao mesmo endpoint devolveram `total_errors = 101` em todas — o que só
é possível porque o estado está no DynamoDB, e não na memória de cada processo.
Com o backend em memória, a mesma verificação devolveu alternadamente `101` e `0`,
conforme o worker que atendeu a requisição.

### 8.3 CORS entre o S3 e a EC2

| Origem enviada | `Access-Control-Allow-Origin` na resposta |
| --- | --- |
| `http://g05-telemetria-front.s3-website-us-east-1.amazonaws.com` | devolvido, igual à origem |
| `http://exemplo-qualquer.com` | ausente |

A liberação é restrita ao prefixo `/v1/*` e à origem do bucket. Um navegador
carregando a página de qualquer outra origem tem a chamada bloqueada.

### 8.4 Página estática no S3

```
GET http://g05-telemetria-front.s3-website-us-east-1.amazonaws.com  → HTTP 200
GET .../config.js  → API_BASE_URL = "http://35.172.27.238"
```

A página foi carregada em navegador real e renderizou os quatro cartões de erro, os
quatro de QoE, o gráfico de evolução e o ranking com os seis códigos da massa de
demonstração, com o selo **API conectada** ativo e nenhum erro no console. As cinco
chamadas responderam em 74 ms, 73 ms, 73 ms e 73 ms.

> **Uso do endpoint de website, e não do REST.** O painel é servido pelo endereço
> `s3-website-us-east-1.amazonaws.com`, que responde em HTTP. O endpoint REST
> (`https://<bucket>.s3.amazonaws.com`) responde em HTTPS, e uma página HTTPS não
> tem permissão de chamar uma API em HTTP — o navegador bloqueia por conteúdo misto,
> sem mensagem visível na interface. É também a razão de não haver CloudFront nesta
> sprint.

---

## 9. Observações e limitações

**A execução consolidada da seção 3 foi feita contra o ambiente local.** A sessão do
laboratório havia encerrado no momento da consolidação deste relatório, o que desliga
a instância EC2. As verificações da seção 8 foram feitas contra a AWS enquanto a
sessão estava ativa, e o vídeo registra a API respondendo no endereço público. Para
reproduzir a execução completa contra a AWS, basta iniciar a instância e rodar o
comando da seção 2 com o arquivo de ambiente `aws`.

**A massa de demonstração expira em 24 horas.** A plataforma descarta telemetria mais
antiga que esse período, e o TTL do DynamoDB remove os itens vencidos. É um
comportamento de projeto, não uma limitação: um painel de monitoração que exibisse
dados de três dias atrás estaria errado. Antes de qualquer nova demonstração, execute:

```bash
cd apps/basica/backend
.venv/bin/python scripts/seed_demo.py --base-url http://<endereço-da-api>
```

**A API responde em HTTP, sem TLS.** Certificado exige domínio próprio, que está fora
do escopo desta sprint e do que o laboratório da AWS Academy permite provisionar.

**A janela padrão das consultas é de 15 minutos.** Requisições sem o parâmetro
`window` devolvem números bem menores que os do painel, que consulta 24 horas. Não é
divergência entre as camadas: é o mesmo dado sob perguntas diferentes.

---

## 10. Testes automatizados do backend

Complementarmente à coleção do Postman, o backend tem suíte própria de testes
unitários e de integração, executável sem nenhuma dependência de rede:

```bash
cd apps/basica/backend
.venv/bin/python -m unittest discover -s tests -t .    # 160 testes, 0 falhas
.venv/bin/ruff check . && .venv/bin/ruff format --check .
```

A suíte cobre o domínio, os serviços, os repositórios (em memória e DynamoDB) e os
controllers. O repositório DynamoDB é exercitado contra um emulador HTTP real, o que
valida a montagem das chaves de partição, as consultas por intervalo e o TTL sem
depender de uma conta AWS ativa.
