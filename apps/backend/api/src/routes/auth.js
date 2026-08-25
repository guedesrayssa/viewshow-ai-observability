/**
 * Auth mínimo pra fechar o fluxo de login do frontend (lib/auth.ts) — sem
 * Cognito/SSO de verdade nesta fase. Usuário fixo por env var, cookie
 * assinado com HMAC. O frontend só olha o status HTTP, não lê o corpo.
 */
const crypto = require("crypto");
const { Router } = require("express");

const router = Router();

const AUTH_USER_EMAIL = process.env.AUTH_USER_EMAIL || "demo@globoplay.com";
const AUTH_USER_PASSWORD = process.env.AUTH_USER_PASSWORD || "demo123";
const COOKIE_SECRET = process.env.AUTH_COOKIE_SECRET || "troque-este-segredo-em-producao";

function signSession(email) {
  const payload = Buffer.from(email, "utf-8").toString("base64url");
  const signature = crypto.createHmac("sha256", COOKIE_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

router.post("/login", (req, res) => {
  const { email, password } = req.body || {};

  if (email !== AUTH_USER_EMAIL || password !== AUTH_USER_PASSWORD) {
    return res.status(401).json({ error: { message: "Credenciais inválidas" } });
  }

  res.cookie("session", signSession(email), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 8 * 60 * 60 * 1000,
  });
  res.status(200).json({ status: "ok" });
});

// SSO de verdade fica pra depois desta fase — stub explícito, não silencioso.
router.get("/sso", (req, res) => {
  res.status(501).json({ error: { message: "SSO ainda não implementado nesta fase" } });
});

module.exports = router;
