const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Rota de "estou vivo" — serve para testar se a API está no ar
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Rota de itens — HOJE com dados falsos (mock), amanhã vamos trocar por dados reais do DynamoDB
app.get("/items", (req, res) => {
  const mockItems = [
    { device_id: "tv-001", event_type: "video_view", status: "ok", timestamp: "2026-08-20T10:00:00Z" },
    { device_id: "tv-002", event_type: "video_pause", status: "ok", timestamp: "2026-08-20T10:05:00Z" },
    { device_id: "tv-003", event_type: "error", status: "fail", timestamp: "2026-08-20T10:10:00Z" },
  ];
  res.json(mockItems);
});

app.listen(PORT, () => {
  console.log(`API rodando em http://localhost:${PORT}`);
});