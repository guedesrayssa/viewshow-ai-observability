const { Router } = require("express");
const evidenceService = require("../services/evidenceService");
const orchestrator = require("../orchestrator");

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

router.post("/:id/diagnose", async (req, res) => {
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
