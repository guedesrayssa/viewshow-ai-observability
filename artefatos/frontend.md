# Validação de requisitos no frontend — AWS Learner Lab

Este plano valida o MVP **implantado** do View Show. O objetivo não é testar
detalhes de implementação isolados: cada caso produz evidência de aceite para
um requisito funcional (RF), não funcional (RNF), interface externa (RIE) ou
restrição (RESTR) da especificação.

O frontend avaliado é o painel estático em `apps/basica/frontend`, servido pelo
S3. Ele consulta a API Flask da EC2, que persiste a telemetria no DynamoDB. A
versão em `apps/frontend` é uma evolução Next.js ainda não publicada no fluxo
documentado do Learner Lab e não faz parte desta rodada de evidências.

## 1. Escopo e critérios de execução

| Item | Definição para esta rodada |
| --- | --- |
| Ambiente | AWS Academy Learner Lab do grupo, região `us-east-1`: S3 Website Hosting (painel), EC2 `t3.micro`/Gunicorn (API) e DynamoDB (`telemetry`). |
| Janela | Executar enquanto a sessão do laboratório estiver ativa. A EC2 deve estar iniciada; a massa expira em 24 h. |
| Dados | Somente dados sintéticos gerados por `seed_demo.py` e códigos exclusivos com prefixo `TESTE_REQ_`; nenhum dado pessoal ou credencial deve ser enviado. |
| Ferramentas | Navegador com DevTools, `curl` e a coleção Postman/Newman versionada. Lighthouse é usado para RNF07. |
| Pré-condições | `telemetria.service` ativo, `TELEMETRY_BACKEND=dynamodb`, bucket publicado com `config.js` apontando para o Elastic IP e CORS liberado exclusivamente para a URL do S3. |
| Aprovação | Um caso passa apenas se o resultado observado satisfizer o critério da tabela e a evidência for registrada. Status HTTP isolado não é evidência suficiente quando houver resultado exibido no painel. |

Antes da execução, iniciar a instância, semear a massa e conferir o serviço:

```bash
# na EC2
systemctl status telemetria --no-pager
cd ~/g05/apps/basica/backend
.venv/bin/python scripts/seed_demo.py --base-url http://localhost

# na máquina do grupo, contra a AWS
npx newman run artefatos/postman/telemetria-globoplay.postman_collection.json \
  -e artefatos/postman/aws.postman_environment.json
```

Se o Elastic IP tiver mudado, atualizar somente o ambiente `aws` do Postman e
republicar o frontend com `deploy-frontend.sh`, conforme `deploy-aws.md`.

## 2. Casos de validação

| ID | Teste | Procedimento | Critério de aceite | Requisitos | Evidência |
| --- | --- | --- | --- | --- | --- |
| VRF-01 | Carregamento do painel | Abrir a URL **S3 Website** em aba anônima depois de semear a massa. | O painel carrega sem erro no console e exibe cartões de erros, cartões de QoE, gráfico e ranking preenchidos com dados da API. | RF07, RF08, RNF07 | Screenshot, console e Network com os GETs `200`. |
| VRF-02 | Evento refletido no site | Enviar erro fatal com código único `TESTE_REQ_<timestamp>` e recarregar o painel. | O código enviado aparece no ranking; totais de erros/sessões e a taxa refletem o dado consultado. | RF02, RF08, RIE02 | Resposta do POST, GET de ranking e screenshot do painel. |
| VRF-03 | Detalhamento de erro | No ranking, selecionar o erro criado em VRF-02. | A tela exibe detalhe, impacto, segmentações e linha do tempo do mesmo código, sem erro no console. | RF05, RF07, RF09 | Screenshot do detalhe e chamada `GET /details`. |
| VRF-04 | Entrada inválida | Enviar lote com um erro válido e outro sem `session_id`; repetir com corpo JSON malformado. | Item válido é aceito, inválido é recusado com motivo e corpo malformado retorna `400`, sem indisponibilizar o painel. | RF02, RNF03, RIE02 | Respostas da API e recarga bem-sucedida do site. |
| VRF-05 | Comunicação S3–EC2 | No navegador e com `curl`, consultar a API com a origem do S3 e com origem não autorizada. | A origem do S3 é liberada por CORS e o site permanece funcional; a origem externa não recebe `Access-Control-Allow-Origin`. | RNF04 (parcial), RIE02 | Cabeçalhos e Network do navegador. |
| VRF-06 | Desempenho do painel | Executar 20 consultas representativas, calcular o P95 e rodar Lighthouse na URL do S3. | P95 das consultas é até 2 s e FCP é até 30 s. | RNF14, RNF07 | Tempos, cálculo do P95 e relatório Lighthouse. |
| VRF-07 | Persistência e recuperação | Fazer seis consultas ao resumo e recarregar o painel após reiniciar a EC2. | Totais consistentes entre workers; serviço volta automaticamente e o site consulta o mesmo Elastic IP. | RF02, RNF09 (parcial), RESTR02 | Saídas dos GETs, `systemctl` e screenshot pós-reinício. |

## 3. Rastreabilidade e limites do MVP implantado

| Requisito | Situação nesta rodada | Casos / motivo |
| --- | --- | --- |
| RF01 e RF06 | Parcial | O MVP aceita telemetria, mas a rodada enxuta não cobre todos os formatos e tipos mínimos individualmente. A cobertura completa está na coleção da API. |
| RF02 | Validável | VRF-02, VRF-04 e VRF-07 comprovam ingestão, consulta e persistência. |
| RF03 | Parcial | O MVP preserva e agrega os campos recebidos, mas ainda não expõe uma prova completa de normalização entre schemas legados distintos. |
| RF04 e RNF04 (SSO) | Não validável | O MVP AWS atual não implementa SSO, cadastro nem proteção autenticada das APIs. VRF-05 valida somente a restrição de origem CORS, que não substitui autenticação. |
| RF05 | Parcial | VRF-03 valida o detalhamento disponível no painel; a alternância completa entre bruto e normalizado pertence à evolução do produto. |
| RF07, RF08 e RF09 | Validável no escopo do MVP | VRF-01 a VRF-03 comprovam painel, métricas, ranking, detalhe e consultas. Filtros cumulativos completos ainda não estão publicados no painel estático. |
| RF10 | Não validável | Não há exportação CSV/XLSX/PDF no MVP AWS. |
| RNF01, RNF02, RNF05, RNF06, RNF08, RNF11, RNF12, RNF13 e RNF15 | Fora da capacidade do MVP/Learner Lab atual | Exigem fila/worker/ML, políticas hot-cold, contêineres, cobertura de CI, carga de escala ou alertas que não estão implantados nesta arquitetura. |
| RNF03, RNF07, RNF14 e RNF09 | Validável ou parcialmente validável | VRF-04, VRF-01/VRF-06, VRF-06 e VRF-07, respectivamente. A janela curta do laboratório não demonstra formalmente disponibilidade anual de 99,9%. |
| RIE02 e RESTR02 | Validável | VRF-02, VRF-04 e VRF-07. |
| RIE01 e RESTR01 | Não validável | Dependem do SSO corporativo, ausente no MVP publicado. |

## 4. Registro dos resultados

Para cada caso, registrar: ID, data/hora UTC, commit, URL do S3, Elastic IP,
ambiente Postman, massa usada, resultado (passou/falhou/bloqueado), tempo de
resposta quando aplicável e link para a evidência. Não usar print isolado como
única prova de VRF-02 ou VRF-03: registrar também a requisição que originou o
dado e a consulta que o exibiu.

Ao fim, anexar o relatório Newman, os relatórios Lighthouse e as capturas do
navegador ao relatório da sprint. Uma falha deve apontar o requisito afetado e
abrir defeito; um requisito marcado como “não validável” permanece explícito,
sem ser confundido com requisito atendido.
