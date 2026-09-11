# Implementação

- **Status:** registro do que está construído
- **Versão:** 1.0
- **Última atualização:** 10/09/2026
- **Responsáveis:** equipe do projeto

## Objetivo

Esta pasta registra **como cada componente foi construído, o que a construção
produziu como resultado e como rodar e validar o que existe**. Um documento
daqui responde três perguntas: o que está implementado, o que a verificação
mostrou e o que ainda falta.

Ela não é fonte normativa de nada. Contratos, regras e decisões arquiteturais
ficam nos documentos da pasta [`arquitetura`](../README.md), e cada documento de
implementação aponta para o seu — mantendo a regra editorial de **uma decisão,
um único lugar oficial**. Quando a implementação e o documento normativo
divergirem, o normativo vence, e a divergência é uma pendência a registrar.

A diferença para o [status de implementação](../status-implementacao.md) é de
granularidade: o status é o painel de cobertura de todo o sistema; aqui fica o
detalhe de um componente, com estrutura de código, decisões de construção,
evidência de verificação e instruções de execução.

## Componentes

### [Camada agêntica](camada-agentica/)

Decide se um sinal de aprendizado de máquina merece investigação e produz
hipóteses de causa raiz ancoradas em evidência.

- [`camada-agentica.md`](camada-agentica/camada-agentica.md): o que é, padrão
  arquitetural adotado, organização de pastas e tecnologias com o motivo de cada
  escolha, fluxo de investigação, decisões do projeto, verificação, implantação
  na AWS, pendências e conferência contra a fonte normativa.
- [`avaliacao-modelos.md`](camada-agentica/avaliacao-modelos.md): medição de dois
  modelos e duas versões de prompt sobre cinco casos, com recomendação e
  limitações.

Fonte normativa: [`analise-e-ia.md`](../analise-e-ia.md).

## Formato dos documentos

Cada documento informa status, versão, data, onde está o código e qual é a sua
fonte normativa. A ordem é sempre a mesma: o que existe, como está construído,
por que foi construído assim, como verificar, o que falta e a conferência contra
o documento normativo.

Resultado medido é reportado como medição, com o ambiente em que foi obtido.
Estimativa é declarada como estimativa. Toda instrução de execução deve rodar
como está escrita, a partir da raiz do repositório.
