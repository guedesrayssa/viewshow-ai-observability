import type { BadgeTone } from "@/components/ui/badge";
import {
  formatCivilDate,
  localIsoDate,
  type ImportSnapshot,
  type ImportState,
} from "@/lib/imports/types";

export { formatCivilDate, localIsoDate };

export type ImportStatePresentation = {
  label: string;
  tone: BadgeTone;
  message: string;
};

const STATE_PRESENTATION: Record<ImportState, ImportStatePresentation> = {
  PREPARING: {
    label: "Preparando upload",
    tone: "neutral",
    message: "Preparando o envio seguro do arquivo.",
  },
  UPLOADING: {
    label: "Enviando arquivo",
    tone: "info",
    message: "Upload em andamento.",
  },
  UPLOADED: {
    label: "Upload concluído",
    tone: "info",
    message: "Arquivo recebido. Aguardando o worker.",
  },
  VALIDATING: {
    label: "Validando dump",
    tone: "warning",
    message: "Validando formato, integridade e contrato ARGUS.",
  },
  PROCESSING: {
    label: "Processando dados",
    tone: "info",
    message: "Construindo o candidato sem alterar o dataset ativo.",
  },
  READY: {
    label: "Pronto",
    tone: "success",
    message: "Candidato validado; o dataset ativo não foi alterado.",
  },
  FAILED: {
    label: "Falhou",
    tone: "critical",
    message: "A importação não foi concluída.",
  },
};

const STAGE_LABELS: Readonly<Record<string, string>> = {
  RESTORING: "Restaurando banco",
  VALIDATING: "Validando dados",
  INGESTING: "Ingerindo registros",
  EXTRACTING: "Extraindo registros",
  PROJECTING: "Gerando projeções",
  ARCHIVING: "Publicando arquivos canônicos",
  MATERIALIZING_HOT: "Preparando dados de consulta",
  FINALIZING_CANDIDATE: "Finalizando candidato",
  PUBLISHING: "Publicando candidato",
};

export function importStatePresentation(
  state: ImportState,
): ImportStatePresentation {
  return STATE_PRESENTATION[state];
}

export function importStageLabel(stage: string, substage?: string): string {
  if (stage === "MATERIALIZING_HOT" && substage === "SKIPPED_BY_POLICY")
    return "Ignorado por política";
  return STAGE_LABELS[stage] ?? stage.replaceAll("_", " ");
}

const FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  MYSQL_CONNECTION_LOST:
    "A conexão com o MySQL foi perdida após as tentativas de reconexão. Tente a importação novamente.",
  MYSQL_QUERY_TIMEOUT:
    "A consulta ao MySQL excedeu o tempo limite após novas tentativas. Tente a importação novamente.",
  QUERY_PLAN_INVALID:
    "O plano de consulta do MySQL não permite uma importação segura. Revise os índices da origem antes de tentar novamente.",
  ARCHIVE_PUBLICATION_FAILED:
    "Não foi possível publicar o arquivo canônico. Tente novamente.",
  DYNAMODB_THROTTLED:
    "O armazenamento de controle está temporariamente sobrecarregado. Tente novamente.",
  DISK_PRESSURE:
    "Não há espaço temporário suficiente para concluir a importação.",
  CHECKSUM_MISMATCH:
    "A integridade dos dados da importação não pôde ser confirmada.",
  SOURCE_SCHEMA_INVALID: "O esquema ou a cobertura da origem é incompatível.",
  DATA_RECONCILIATION_FAILED:
    "As evidências publicadas não reconciliam com os dados importados.",
};

export function importFailureMessage(code: string): string {
  return FAILURE_MESSAGES[code] ?? "Não foi possível concluir a importação.";
}

export function importAuthorLabel(snapshot: ImportSnapshot): string {
  return snapshot.author.name ?? snapshot.author.email ?? snapshot.requestedBy;
}

export function shortDatasetVersion(version: string): string {
  return version.startsWith("dsv_")
    ? version.slice(4, 12)
    : version.slice(0, 8);
}

export function formatBytes(value: number): string {
  const safe = Math.max(0, value);
  const units = ["B", "KiB", "MiB", "GiB", "TiB"] as const;
  let amount = safe;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  const maximumFractionDigits =
    amount >= 10 || Number.isInteger(amount) ? 0 : 1;
  return `${amount.toLocaleString("pt-BR", { maximumFractionDigits })} ${units[unit]}`;
}

export function formatLocalInstant(value: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}
