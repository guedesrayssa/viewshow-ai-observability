const { Router } = require("express");
const goldenSetService = require("../services/goldenSetService");

const router = Router();

/**
 * Uso interno do orquestrador (Dia 6) e de uma futura tela de curadoria —
 * nenhuma tela do frontend consome isso hoje. Busca exata por assinatura,
 * sem Scan: GET /api/v1/golden-set?signature=Player#Smart%20TV#Nordeste
 */
router.get("/", async (req, res) => {
  try {
    const { signature } = req.query;
    if (!signature) {
      return res
        .status(400)
        .json({ error: { message: "Informe ?signature=<component>#<deviceType>#<region>" } });
    }

    const goldenCase = await goldenSetService.findMatchingCase(signature);
    if (!goldenCase) {
      return res.status(404).json({ error: { message: "Nenhum caso golden set para essa assinatura" } });
    }

    res.json(goldenCase);
  } catch (error) {
    console.error("Falha ao consultar golden set:", error);
    res.status(500).json({ error: { message: "Falha ao consultar golden set" } });
  }
});

module.exports = router;
