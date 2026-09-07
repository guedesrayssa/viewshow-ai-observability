/**
 * Resumo para /visao-geral. Só usa o que dá pra derivar de incidentes já
 * registrados na tabela operacional (sem Scan). "Taxa de erros" e "latência
 * p95" do mock original do frontend não entraram aqui de propósito: são
 * métricas de telemetria bruta, que vêm do job de ingestão (fora do escopo
 * desta fase) — melhor não ter do que inventar um número.
 *
 * Contrato da resposta (consumido por apps/frontend .../visao-geral):
 *
 *   {
 *     "stats": [
 *       { "id": string, "label": string, "value": number,
 *         "format": "compact" | "integer", "accent": "info"|"warning"|"critical" }
 *     ],
 *     "recentIncidents": Incident[]   // os 5 mais recentes da janela de 24 h
 *   }
 *
 * `value` é numérico de propósito: quem formata é a tela (convenção de
 * apps/frontend/lib/dashboard-data.ts), o que deixa o cartão animar a contagem
 * quando o número muda. `format` diz como escrevê-lo.
 */
const { Router } = require("express");
const evidenceService = require("../services/evidenceService");

const router = Router();

/**
 * Remove repetições do mesmo incidente, ficando com a ocorrência mais recente
 * (menor `startedMinutesAgo`).
 *
 * Execuções distintas do seed gravam o mesmo `id` em baldes de horas
 * diferentes, e `listIncidents` devolve todas. Sem juntar as repetições, o
 * mesmo incidente somaria `devices` mais de uma vez e contaria como vários —
 * inflando os três indicadores — e ainda ocuparia mais de uma vaga entre os
 * recentes. Por isso a deduplicação acontece antes dos agregados e do `slice`.
 */
function dedupeById(incidents) {
  const byId = new Map();

  for (const incident of incidents) {
    const current = byId.get(incident.id);
    const minutesAgo = incident.startedMinutesAgo ?? Infinity;
    const currentMinutesAgo = current
      ? current.startedMinutesAgo ?? Infinity
      : Infinity;

    if (!current || minutesAgo < currentMinutesAgo) {
      byId.set(incident.id, incident);
    }
  }

  return [...byId.values()];
}

router.get("/summary", async (req, res) => {
  try {
    const incidents = dedupeById(
      await evidenceService.listIncidents({ window: "24h" }),
    );

    const affectedSessions = incidents.reduce((total, incident) => total + (incident.devices || 0), 0);
    const activeIncidents = incidents.filter((incident) => incident.status !== "success").length;
    const criticalIncidents = incidents.filter((incident) => incident.status === "critical").length;

    res.json({
      stats: [
        {
          id: "affected-sessions",
          label: "Sessões afetadas",
          value: affectedSessions,
          format: "compact",
          accent: "info",
        },
        {
          id: "active-incidents",
          label: "Incidentes ativos",
          value: activeIncidents,
          format: "integer",
          accent: "warning",
        },
        {
          id: "critical-incidents",
          label: "Incidentes críticos",
          value: criticalIncidents,
          format: "integer",
          accent: "critical",
        },
      ],
      recentIncidents: incidents.slice(0, 5),
    });
  } catch (error) {
    console.error("Falha ao montar resumo do dashboard:", error);
    res.status(500).json({ error: { message: "Falha ao montar resumo do dashboard" } });
  }
});

module.exports = router;
