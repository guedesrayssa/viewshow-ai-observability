<div align="center">
    <h5>Um projeto do Instituto de Tecnologia e Liderança</h5>
<a href="https://www.inteli.edu.br/">
    <img src="./assets/logo-inteli.png" alt="Inteli Logo" width="80px">
</a>
<br>
<p>
    <h5>Parceiro do Módulo: Grupo Globo - Globoplay</h5>
    <a href="https://www.globo.com/">
    <img src="./assets/logo-globo.png" alt="Globo Logo" width="200px">
    </a>
</p>
</div>


# Projeto de Monitoração Agêntica: View Show
<div align="center">

<img src="./assets/logo-view-show.png" alt="View Show Logo" width="100px">
</a>
<br>
</div>



## Grupo 05 - Os Big Brothers

| Integrante 
| --- 
|[**Raiane Araujo Brandão**](https://www.linkedin.com/in/raianearaujobrandao/) |
|[**Rayssa Guedes França**](https://www.linkedin.com/in/rayssaguedess/) |
|[**Messias Olivindo**](https://www.linkedin.com/in/messias-olivindo/) |
|[**Victor Garcia dos Santos**](https://www.linkedin.com/in/victor-garcia-dos-santos/) |
|[**Lucas Michel Pereira**](https://www.linkedin.com/in/lucas-michel-pereira-1a338734b/) |
|[**Marcos Vinicius M. Silva**](https://www.linkedin.com/in/marcos-vinicius-m-silva/) |
|[**Bruno Martins**](https://www.linkedin.com/in/bruno-martins-2b6742269/) |

---

## Descrição do Projeto

Desenvolvido em parceria com o **Grupo Globo**, o projeto busca reduzir o tempo necessário para detectar e diagnosticar degradações na experiência de streaming do Globoplay. A plataforma opera em um cenário de grande escala e alta heterogeneidade, envolvendo diferentes dispositivos, versões de sistemas operacionais, redes, regiões e componentes técnicos.

A solução propõe uma plataforma distribuída para coletar, normalizar, processar e correlacionar dados de telemetria provenientes de aplicações frontend e de diferentes sistemas de monitoração. A partir desses sinais, o sistema deverá identificar anomalias, delimitar os usuários e ambientes afetados e apresentar hipóteses ranqueadas para a causa provável de cada incidente.

O objetivo é oferecer aos times de engenharia e observabilidade uma visão ponta a ponta da experiência do assinante, reduzindo a dependência de análises manuais em múltiplos painéis e acelerando a identificação da causa raiz de falhas.

---

## Objetivos do MVP

- Disponibilizar uma API unificada para ingestão de eventos de telemetria.
- Suportar dispositivos e protocolos modernos e legados.
- Processar e armazenar grandes volumes de eventos com resiliência e sem perdas.
- Normalizar eventos provenientes de fontes e formatos diferentes.
- Correlacionar sinais de múltiplos componentes do ecossistema Globoplay.
- Detectar anomalias e apresentar hipóteses de causa provável com suas evidências.
- Exibir métricas, alertas e eventos em um dashboard com filtros cumulativos.
- Permitir o aprofundamento da análise até o nível de sessão e fonte de dados.

---

## Estrutura do Repositório

```text
/
├── README.md
├── .gitignore
├── apps/basica/backend/
│   ├── app/{controllers,domain,repositories,services}/
│   ├── scripts/
│   └── tests/
├── apps/basica/frontend/{fonts, index.html, app.js, api.js, config.js, styles.css}
├── artefatos/{analise_financeira.md, backend.md, entendimento_ux.md, requisitos.md}
└── assets/{imagens, logos}
```
---

## Histórico de Lançamentos

- **SPRINT 5**


- **SPRINT 4**


- **SPRINT 3**
  

- **SPRINT 2**
 

- **SPRINT 1**
  - Entendimento do negócio e do problema do parceiro
  - Definição do escopo e do MVP
  - Requisitos funcionais e não funcionais
  - Personas, jornadas e histórias de usuário
  - Análise inicial das fontes de dados e proposta preliminar de arquitetura

---

## Licença

<p xmlns:cc="http://creativecommons.org/ns#" xmlns:dct="http://purl.org/dc/terms/">
  <a property="dct:title" rel="cc:attributionURL" href="https://git.inteli.edu.br/graduacao/2026-1b/t15/g05">View Show</a> por
  <a rel="cc:attributionURL dct:creator" property="cc:attributionName"> Raiane, Rayssa, Marcos, Messias, Lucas, Vitor e Bruno</a>
  é licenciado sob
  <a href="http://creativecommons.org/licenses/by/4.0/?ref=chooser-v1" target="_blank" rel="license noopener noreferrer" style="display:inline-block;">
    Attribution 4.0 International (CC BY 4.0)
    <img style="height:22px!important;margin-left:3px;vertical-align:text-bottom;" src="https://mirrors.creativecommons.org/presskit/icons/cc.svg?ref=chooser-v1">
    <img style="height:22px!important;margin-left:3px;vertical-align:text-bottom;" src="https://mirrors.creativecommons.org/presskit/icons/by.svg?ref=chooser-v1">
  </a>
</p>