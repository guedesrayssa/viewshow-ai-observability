# Extensão de linha do tempo do Scrum Board

## Objetivo

Criar uma extensão local para Chrome e Brave que transforme as issues abertas do Scrum Board do projeto G05 em uma linha do tempo. A extensão deve reutilizar a sessão autenticada do GitLab, atualizar os dados sem armazenar credenciais e manter o board como fonte única de verdade.

O código da extensão ficará em `g05-md7/timeline`, no mesmo nível do repositório `g05`. A extensão não fará alterações no GitLab.

## Escopo

A primeira versão deve:

- ler somente as issues abertas do projeto `graduacao/2026-2a/t15/g05`;
- exibir título, labels, responsável, data de início e data de entrega de cada atividade;
- representar o período da atividade por uma barra horizontal;
- atualizar os dados ao abrir a visualização, em intervalos regulares enquanto ela estiver aberta e por ação manual;
- excluir da lista de atividades as issues agregadoras dos artefatos ART 1, ART 2 e ART 3;
- apresentar os três artefatos em uma legenda interativa;
- abrir a descrição do artefato quando o usuário clicar na legenda ou numa label ART de uma atividade;
- abrir a issue original no GitLab quando o usuário clicar em uma atividade;
- mostrar estados de carregamento, erro e ausência de dados.

Não faz parte da primeira versão:

- criar, editar, fechar ou mover issues;
- alterar datas, responsáveis ou labels;
- armazenar tokens, cookies ou senhas;
- sincronizar dados em segundo plano quando o GitLab estiver fechado;
- incluir issues fechadas;
- integrar a linha do tempo ao frontend principal da aplicação G05.

## Abordagem escolhida

Será usada uma extensão Manifest V3 carregada localmente. Um content script será ativado apenas nas páginas do projeto G05 no domínio `git.inteli.edu.br`. Ele adicionará ao Scrum Board um botão **Linha do tempo** e controlará uma visualização isolada da interface do GitLab.

A extensão é preferível a uma página HTML autônoma porque pode reutilizar a sessão autenticada do GitLab sem solicitar ou persistir um token pessoal. Uma página estática não conseguiria se atualizar de forma confiável; uma aplicação com token acrescentaria configuração e risco desnecessários.

## Componentes

### Manifesto

O `manifest.json` limitará a extensão ao host `https://git.inteli.edu.br/*` e ao caminho do projeto G05. As permissões devem ser somente as necessárias para injetar a interface e executar requisições de leitura.

### Cliente do GitLab

Um módulo será responsável por buscar e normalizar os dados. A primeira tentativa usará os endpoints de leitura do GitLab com a sessão existente. Durante a implementação, o formato disponível na instância será verificado; caso o endpoint de listagem não exponha as datas, o módulo complementará os dados consultando o detalhe de cada issue pela interface autenticada.

O cliente retornará objetos independentes da resposta do GitLab:

```ts
type TimelineIssue = {
  iid: number;
  title: string;
  webUrl: string;
  labels: string[];
  assignees: Array<{ name: string; username: string; avatarUrl?: string }>;
  startDate: string | null;
  dueDate: string | null;
};
```

Os artefatos terão uma estrutura separada, com código, título, descrição, arquivo, pastas e itens de entrega.

### Serviço de atualização

Ao abrir a visualização, a extensão fará uma atualização imediata. Enquanto a linha do tempo estiver visível, repetirá a leitura a cada 60 segundos. Um botão **Atualizar agora** permitirá sincronização manual e exibirá o horário da última atualização bem-sucedida.

Uma nova atualização não começará enquanto outra ainda estiver em andamento. Se uma atualização periódica falhar, os últimos dados válidos continuarão visíveis junto de um aviso.

### Interface

A visualização ocupará uma área ampla sobre o conteúdo do board e poderá ser fechada sem recarregar a página. Ela será composta por:

1. cabeçalho com título, total de atividades abertas, horário da última atualização, botão de atualização e botão de fechar;
2. legenda interativa dos artefatos ART 1, ART 2 e ART 3;
3. régua temporal horizontal com dias e indicação do dia atual;
4. trilhas horizontais para ART 1, ART 2, ART 3 e atividades transversais;
5. barras posicionadas dentro das trilhas conforme o início e a entrega de cada atividade;
6. painel ou modal com a descrição completa do artefato selecionado.

Cada trilha ART terá um cabeçalho clicável que abrirá o mesmo conteúdo da legenda. A barra da atividade conterá título, responsáveis e labels não estruturais, sem uma coluna tabular separada. Quando houver mais de um responsável, todos os nomes serão exibidos; quando não houver nenhum, será mostrado **Sem responsável**.

Atividades relacionadas a exatamente um artefato aparecerão na trilha correspondente. Atividades relacionadas a dois ou três artefatos aparecerão uma única vez em **Transversais**, mantendo todas as labels ART visíveis. Atividades sem label ART aparecerão uma única vez em **Outras atividades**. Barras sobrepostas na mesma trilha serão distribuídas em sublinhas para que permaneçam legíveis.

## Regras dos artefatos

As issues agregadoras identificadas como ART 1, ART 2 e ART 3 serão usadas para preencher a legenda e não aparecerão como atividades na linha do tempo. Inicialmente, correspondem às issues:

- `#179` — Arquitetura Funcional do Sistema;
- `#180` — Testes Funcionais do Sistema;
- `#181` — Aplicação Containerizada e Resiliente.

A identificação será feita pelo título e pela label do artefato, com os IIDs acima como referência. A descrição apresentada será lida das issues para acompanhar futuras alterações no board.

## Regras de datas

O intervalo global será calculado a partir da menor data de início e da maior data de entrega encontradas nas atividades abertas que possuem datas. As barras seguirão estas regras:

- início e entrega definidos: usar o período informado;
- início ausente: usar o início global;
- entrega ausente: usar o fim global;
- início e entrega ausentes: ocupar todo o intervalo global;
- início posterior à entrega: mostrar a atividade com alerta de dados inconsistentes, sem inverter silenciosamente as datas.

Se nenhuma atividade tiver qualquer data, a visualização usará a data atual como início e sete dias depois como fim, deixando explícito que o intervalo é um padrão de exibição.

As datas serão tratadas como datas civis, sem conversão de fuso que possa deslocar o dia. A régua incluirá os dois extremos do intervalo.

## Fluxo de dados

1. O usuário abre o Scrum Board autenticado.
2. A extensão reconhece o projeto e adiciona o botão **Linha do tempo**.
3. O usuário abre a visualização.
4. O cliente consulta as issues abertas e os três artefatos.
5. Os dados são normalizados e validados.
6. As issues agregadoras são separadas das atividades.
7. O intervalo global e as posições das barras são calculados.
8. A interface é renderizada e informa o horário da sincronização.
9. A atualização manual ou periódica repete o fluxo e substitui os dados somente após uma leitura válida.

## Segurança e privacidade

A extensão não terá campos para credenciais e não persistirá cookies, tokens nem conteúdo do projeto. Todas as leituras ocorrerão diretamente entre o navegador autenticado e `git.inteli.edu.br`. Nenhum dado será enviado a serviços externos.

O acesso ao DOM será limitado às páginas do projeto G05. Links de issues serão abertos no próprio domínio do GitLab.

## Tratamento de erros

- **Sessão expirada:** orientar o usuário a autenticar novamente no GitLab.
- **Sem permissão:** informar que o projeto não pôde ser lido.
- **Resposta incompleta:** manter os campos disponíveis e marcar os ausentes.
- **Falha de atualização:** preservar o último estado válido e oferecer nova tentativa.
- **Nenhuma issue aberta:** mostrar um estado vazio, mantendo a legenda dos artefatos quando disponível.
- **Descrição de artefato indisponível:** mostrar o título e um aviso no lugar da descrição.

## Acessibilidade e responsividade

Todos os controles serão acessíveis por teclado e terão nomes claros para leitores de tela. O modal de artefato prenderá o foco enquanto estiver aberto e poderá ser fechado por `Esc`. Cores de labels e barras terão texto ou ícones redundantes, evitando depender apenas da cor.

Em telas menores, os cabeçalhos das trilhas permanecerão fixos e a área temporal permitirá rolagem horizontal. O layout principal será otimizado para desktop, onde o board é normalmente utilizado. A visualização não deve assumir aparência de tabela: títulos e responsáveis ficam nas próprias barras, enquanto linhas e colunas servem apenas como estrutura temporal discreta.

## Estrutura prevista

```text
g05-md7/timeline/
├── manifest.json
├── src/
│   ├── content-script.ts
│   ├── gitlab-client.ts
│   ├── model.ts
│   ├── timeline.ts
│   ├── timeline-view.ts
│   └── styles.css
├── tests/
│   ├── gitlab-client.test.ts
│   ├── timeline.test.ts
│   └── timeline-view.test.ts
├── package.json
├── tsconfig.json
└── README.md
```

A estrutura poderá receber pequenos ajustes de nomes durante a implementação, mantendo as responsabilidades separadas.

## Estratégia de testes

Os testes automatizados cobrirão:

- normalização de issues, labels, responsáveis e artefatos;
- exclusão das três issues agregadoras;
- cálculo do intervalo global;
- regras para datas ausentes e datas inconsistentes;
- posicionamento, largura e empilhamento das barras nas trilhas;
- classificação em ART 1, ART 2, ART 3, Transversais e Outras atividades;
- abertura e fechamento da descrição de artefato;
- estados de carregamento, erro, atualização e lista vazia.

A validação manual será feita no Scrum Board autenticado em Chrome ou Brave, verificando:

- carregamento das 31 issues abertas existentes no momento da especificação;
- atualização após recarregar ou alterar o board;
- links para as issues;
- leitura das descrições de ART 1, ART 2 e ART 3;
- comportamento em larguras de desktop e janela reduzida;
- navegação por teclado.

## Critérios de aceite

A entrega estará aceita quando:

1. a extensão puder ser carregada localmente a partir de `g05-md7/timeline`;
2. o botão **Linha do tempo** aparecer no Scrum Board do G05;
3. somente as issues abertas não agregadoras forem exibidas como atividades;
4. cada atividade mostrar título, labels, responsável e uma barra temporal coerente com as regras definidas;
5. a legenda ART abrir as descrições vindas das issues de artefato;
6. a visualização refletir mudanças do board após atualização automática ou manual;
7. nenhuma operação de escrita for enviada ao GitLab;
8. os testes automatizados e a validação manual passarem.
