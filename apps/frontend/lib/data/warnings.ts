/**
 * @file warnings.ts
 * Avisos que uma leitura pode carregar até a tela.
 *
 * O código é o que a interface usa para decidir o que desenhar; a mensagem é o
 * que ela mostra quando não tem tratamento próprio para aquele código. Os dois
 * ficam juntos aqui para que o mesmo motivo não seja escrito de três jeitos
 * diferentes em três telas.
 *
 * Um aviso não é um erro: a resposta continua utilizável. Ele diz o que dela
 * não pôde ser preenchido, e por quê.
 */

/** Motivo pelo qual parte de uma leitura não pôde ser preenchida. */
export type Warning = {
  code: string;
  message: string;
};

export const WARNINGS = {
  /** A API operacional não foi apontada por variável de ambiente. */
  apiNaoConfigurada: {
    code: "API_NOT_CONFIGURED",
    message: "Nenhuma API de telemetria configurada neste ambiente.",
  },
  /** A leitura saiu, mas não voltou. A mensagem exata entra no lugar desta. */
  leituraFalhou: {
    code: "READ_FAILED",
    message: "Não foi possível ler a telemetria.",
  },
  /** O número na tela é de exemplo, não medição. */
  dadoDeExemplo: {
    code: "EXAMPLE_DATA",
    message: "Os números são de um conjunto de exemplo, não de medição.",
  },
  /** Não existe linha de base aprovada para a série de saúde. */
  semLinhaDeBase: {
    code: "BASELINE_UNAVAILABLE",
    message: "Sem linha de base publicada para comparar a série.",
  },
  /** Nenhuma fonte reconstrói evento individual a partir de agregado. */
  eventosIndividuais: {
    code: "INDIVIDUAL_EVENTS_UNAVAILABLE",
    message:
      "Eventos individuais não possuem fonte configurada nesta fase: os agregados não reconstroem o evento.",
  },
  /** O pipeline é batch e não tem fila — indisponível por desenho. */
  pipelineSemFila: {
    code: "QUEUELESS_BATCH_PIPELINE",
    message:
      "O pipeline atual é em lote e não tem fila: profundidade de fila e DLQ não existem por desenho.",
  },
  /** Nenhuma das APIs segmenta por unidade federativa. */
  semDimensaoGeografica: {
    code: "GEOGRAPHY_UNAVAILABLE",
    message:
      "Nenhuma API atual segmenta por unidade federativa; a projeção geográfica ainda não existe.",
  },
  /** A API operacional não respondeu; o bloco que depende dela ficou vazio. */
  operacionalIndisponivel: {
    code: "OPERATIONAL_API_UNAVAILABLE",
    message:
      "A API de incidentes não respondeu: os blocos que dependem dela ficaram vazios.",
  },
  /** Nenhuma execução do pipeline publica taxa, latência ou cobertura. */
  pipelineSemInstrumentacao: {
    code: "PIPELINE_RUN_METRICS_UNAVAILABLE",
    message:
      "A execução do pipeline ainda não registra taxa, latência nem cobertura: a saúde da ingestão não é medida nesta fase.",
  },
  /** O incidente não tem hipótese registrada ainda. */
  semHipotese: {
    code: "HYPOTHESIS_NOT_READY",
    message: "Este incidente ainda não passou por diagnóstico.",
  },
  /** A grandeza pedida não é medida pela fonte que serve o resto do bloco. */
  metricaSemFonte: {
    code: "METRIC_UNAVAILABLE",
    message:
      "Esta medição não é publicada pela fonte que serve o restante do bloco.",
  },
} as const satisfies Record<string, Warning>;
