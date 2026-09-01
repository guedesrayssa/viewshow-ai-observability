const { Router } = require("express");
const evidenceService = require("../services/evidenceService");
const goldenSetService = require("../services/goldenSetService");
const orchestrator = require("../orchestrator");
const requireAuth = require("../middleware/requireAuth");

const router = Router();

router.get("/", async (req, res) => {
  try {
    const { window, deviceType, region, appVersion } = req.query;
    const incidents = await evidenceService.listIncidents({ window, deviceType, region, appVersion });
    res.json({ incidents });
  } catch (error) {
    console.error("Falha ao listar incidentes:", error);
    res.status(500).json({ error: { message: "Falha ao listar incidentes" } });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const incident = await evidenceService.getIncidentById(req.params.id);
    if (!incident) return res.status(404).json({ error: { message: "Incidente não encontrado" } });
    res.json(incident);
  } catch (error) {
    console.error("Falha ao buscar incidente:", error);
    res.status(500).json({ error: { message: "Falha ao buscar incidente" } });
  }
});

router.get("/:id/evidence", async (req, res) => {
  try {
    const evidence = await evidenceService.getEvidenceByIncidentId(req.params.id);
    res.json({ evidence });
  } catch (error) {
    console.error("Falha ao buscar evidências:", error);
    res.status(500).json({ error: { message: "Falha ao buscar evidências" } });
  }
});

router.get("/:id/hypothesis", async (req, res) => {
  try {
    const hypothesis = await evidenceService.getLatestHypothesis(req.params.id);
    if (!hypothesis) {
      return res.status(404).json({ error: { message: "Nenhuma hipótese registrada para este incidente" } });
    }
    res.json(hypothesis);
  } catch (error) {
    console.error("Falha ao buscar hipótese:", error);
    res.status(500).json({ error: { message: "Falha ao buscar hipótese" } });
  }
});

/**
 * Revisão humana da hipótese (US-ENG-01) — exige sessão autenticada porque,
 * quando confirmada, promove o caso à golden set (ADR-005). É o único
 * gatilho de escrita nessa tabela em todo o código da API.
 */
router.patch("/:id/hypothesis/review", requireAuth, async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!["confirmed", "refuted"].includes(status)) {
      return res.status(400).json({ error: { message: "status deve ser 'confirmed' ou 'refuted'" } });
    }

    const hypothesis = await evidenceService.reviewHypothesis(req.params.id, {
      status,
      reviewedBy: req.userEmail,
    });
    if (!hypothesis) {
      return res.status(404).json({ error: { message: "Nenhuma hipótese registrada para este incidente" } });
    }

    if (status === "confirmed") {
      const incident = await evidenceService.getIncidentById(req.params.id);
      await goldenSetService.promoteCase(incident, hypothesis, req.userEmail);
    }

    res.json(hypothesis);
  } catch (error) {
    console.error("Falha ao revisar hipótese:", error);
    res.status(500).json({ error: { message: "Falha ao revisar hipótese" } });
  }
});

/**
 * Dispara o diagnóstico do incidente (orquestrador → golden set ou agente).
 * Exige sessão: apesar de ser um POST de leitura do ponto de vista do usuário,
 * ele ESCREVE uma hipótese na tabela operacional a cada chamada e consome LLM.
 * Aberta, permitia que qualquer um inflasse a tabela e a conta.
 */
router.post("/:id/diagnose", requireAuth, async (req, res) => {
  try {
    const result = await orchestrator.diagnose(req.params.id);
    if (!result) return res.status(404).json({ error: { message: "Incidente não encontrado" } });
    res.json(result);
  } catch (error) {
    console.error("Falha ao diagnosticar incidente:", error);
    res.status(500).json({ error: { message: "Falha ao diagnosticar incidente" } });
  }
});

module.exports = router;
