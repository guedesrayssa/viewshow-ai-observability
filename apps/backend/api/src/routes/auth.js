/**
 * Autenticação do painel: entrada, criação de conta e o stub de SSO.
 *
 * A sessão é um cookie assinado com HMAC (auth/session.js). Além do usuário
 * fixo de demonstração (env vars), o login aceita contas criadas pela tela de
 * criar conta, guardadas pelo userService com hash de senha — sem Cognito/SSO
 * de verdade nesta fase.
 */
const { Router } = require("express");
const { signSession } = require("../auth/session");
const userService = require("../services/userService");

const router = Router();

const AUTH_USER_EMAIL = process.env.AUTH_USER_EMAIL || "demo@globoplay.com";
const AUTH_USER_PASSWORD = process.env.AUTH_USER_PASSWORD || "demo123";

/** Formato mínimo de e-mail: algo, arroba, domínio com ponto e sem espaços. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MIN_PASSWORD_LENGTH = 8;

function setSessionCookie(res, email) {
  res.cookie("session", signSession(email), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 8 * 60 * 60 * 1000,
  });
}

router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};

  const isFixedUser = email === AUTH_USER_EMAIL && password === AUTH_USER_PASSWORD;
  const registered = isFixedUser
    ? null
    : await userService.authenticate(email, password);

  if (!isFixedUser && !registered) {
    return res.status(401).json({ error: { message: "Credenciais inválidas" } });
  }

  setSessionCookie(res, userService.normalizeEmail(email));
  res.status(200).json({ status: "ok", name: registered ? registered.name : null });
});

/**
 * Cria uma conta e já abre a sessão: quem acabou de se cadastrar não precisa
 * digitar a mesma senha de novo na tela seguinte.
 */
router.post("/register", async (req, res) => {
  const { name, email, password } = req.body || {};

  if (!String(name || "").trim()) {
    return res.status(400).json({ error: { message: "Informe o seu nome." } });
  }
  if (!EMAIL_PATTERN.test(String(email || "").trim())) {
    return res.status(400).json({ error: { message: "Digite um e-mail válido." } });
  }
  if (String(password || "").length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({
      error: {
        message: `A senha precisa de pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`,
      },
    });
  }
  if (userService.normalizeEmail(email) === AUTH_USER_EMAIL) {
    return res
      .status(409)
      .json({ error: { message: "Este e-mail já está registrado." } });
  }

  try {
    const created = await userService.createUser({ name, email, password });
    if (!created) {
      return res
        .status(409)
        .json({ error: { message: "Este e-mail já está registrado." } });
    }

    setSessionCookie(res, created.email);
    res.status(201).json({ status: "ok", name: created.name });
  } catch (error) {
    console.error("Falha ao criar conta:", error);
    res.status(500).json({ error: { message: "Falha ao criar a conta" } });
  }
});

// SSO de verdade fica pra depois desta fase — stub explícito, não silencioso.
router.get("/sso", (req, res) => {
  res.status(501).json({ error: { message: "SSO ainda não implementado nesta fase" } });
});

module.exports = router;
