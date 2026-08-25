const { Router } = require("express");
const mlService = require("../services/mlService");

const router = Router();

router.post("/analyze", (req, res) => {
  res.json(mlService.analyze(req.body));
});

module.exports = router;
