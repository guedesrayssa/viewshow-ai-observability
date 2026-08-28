const express = require("express");
const cors = require("cors");

const healthRouter = require("./routes/health");
const incidentsRouter = require("./routes/incidents");
const goldenSetRouter = require("./routes/goldenSet");
const mlRouter = require("./routes/ml");
const authRouter = require("./routes/auth");
const dashboardRouter = require("./routes/dashboard");

const app = express();
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || true, credentials: true }));
app.use(express.json());

app.use("/health", healthRouter);
app.use("/auth", authRouter);
app.use("/api/v1/incidents", incidentsRouter);
app.use("/api/v1/golden-set", goldenSetRouter);
app.use("/api/v1/ml", mlRouter);
app.use("/api/v1/dashboard", dashboardRouter);

module.exports = app;
