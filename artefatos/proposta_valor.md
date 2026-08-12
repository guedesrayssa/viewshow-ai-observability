# Canvas de Proposta de Valor 

&nbsp;&nbsp;&nbsp;&nbsp;A Proposta de Valor (Value Proposition Canvas) é um modelo estratégico de posicionamento de mercado que define o conjunto de benefícios tangíveis e intangíveis que uma organização se compromete a entregar aos seus segmentos de clientes. Ela atua como o núcleo de diferenciação competitiva, alinhando as capacidades operacionais da empresa com as necessidades específicas do mercado-alvo.


---

## Perfil do Cliente 

&nbsp;&nbsp;&nbsp;&nbsp;O cliente deste projeto é o conjunto de times internos responsáveis pela operação do serviço de streaming da Globo (GloboPlay): times de Engenharia de Aplicativos (mobile, web, TV), Engenharia de Plataforma de Vídeo, SRE/Observabilidade e Produto. Esses times atuam em um contexto de alta escala e alta heterogeneidade de dispositivos, onde coexistem Smart TVs modernas, TVs com firmware antigo, set-top boxes, dispositivos móveis com diversas versões de sistema operacional e navegadores com capacidades distintas.

Internamente, esses times são cobrados por manter a qualidade de experiência (QoE) do usuário final, cumprir SLAs de disponibilidade e desempenho e controlar custos operacionais ligados à observabilidade e monitoramento. Externamente, o serviço é avaliado por milhões de usuários que esperam que o conteúdo esteja disponível rapidamente, sem travamentos e com qualidade consistente, independentemente do dispositivo.

O cliente, portanto, não é um usuário final individual, mas uma organização técnica que depende de telemetria confiável para operar o produto de streaming com segurança. A solução proposta precisa dialogar diretamente com essa realidade: alta escala, ambiente heterogêneo, necessidade de diagnóstico rápido e forte pressão por eficiência operacional e econômica.

---

## 1.1 Tarefas do Cliente 

As tarefas do cliente podem ser divididas em funcionais, sociais e emocionais, cada uma respresentando a responsabilidade da equipe em concluir a operaçao em diferentes níveis. 

### Tarefas funcionais

Funcionalmente, os times precisam:

- Monitorar a saúde do aplicativo e do player em múltiplas plataformas (mobile, web, TVs, dispositivos legados), acompanhando eventos como screen_view, video_view, request, session e error.

- Detectar rapidamente degradações de qualidade de experiência (QoE), como aumento de tempo de carregamento de vídeo, falhas de início de playback, aumento de erros de requisição ou ANRs em dispositivos específicos.

- Investigar a causa raiz de incidentes, correlacionando eventos de frontend com backend, CDN e plataforma de vídeo para responder perguntas como “o problema está no app, na API, na CDN ou na infraestrutura do dispositivo?”.

- Cumprir SLAs e metas internas, garantindo que indicadores como taxa de playback bem-sucedido, latência de startup e estabilidade por dispositivo/região se mantenham dentro de limites aceitáveis.

- Reduzir custos de observabilidade, buscando alternativas a ferramentas externas de RUM/APM que se tornam muito caras em ambientes com grande volume de sessões.

- Integrar telemetria com o ecossistema interno, exportando dados para data lakes, ferramentas de alerta, sistemas de ticket e dashboards já utilizados pela empresa.

### Tarefas sociais

No plano social, esses times precisam:

- Demonstrar para a liderança técnica e de negócios que possuem controle sobre a saúde do produto, apresentando dados claros sobre estabilidade e qualidade de experiência.

- Construir credibilidade com outras áreas, como Produto e Conteúdo, mostrando que problemas técnicos são detectados e mitigados com rapidez.

- Sustentar a imagem da empresa como uma plataforma de streaming confiável, que funciona bem nos principais eventos (jogos, finais de reality, estreias de novelas e séries).

- Coordernar resposta a incidentes entre múltiplos times, o que exige uma fonte de verdade única sobre o que está acontecendo nos dispositivos dos usuários.

### Tarefas emocionais

Em termos emocionais, há várias pressões importantes:

- Reduzir a ansiedade e o estresse durante grandes eventos, evitando a sensação de “voo às cegas” quando a audiência dispara.

- Ter segurança de que, ao lançar uma nova versão de app, os times conseguirão detectar rapidamente qualquer regressão de QoE ou estabilidade.

- Sentir autonomia técnica, sem depender totalmente de decisões de fornecedores externos para algo tão crítico quanto a observabilidade do produto.

- Orgulho profissional de operar uma plataforma de streaming com um nível de monitoramento sofisticado e adequado à realidade da base de dispositivos.