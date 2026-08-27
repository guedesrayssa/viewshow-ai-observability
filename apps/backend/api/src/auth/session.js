/**
 * Assinatura/verificação do cookie de sessão — compartilhado entre
 * routes/auth.js (assina no login) e middleware/requireAuth.js (verifica
 * nas rotas protegidas). Único lugar que conhece o segredo e o formato.
 */
const crypto = require("crypto");

const COOKIE_SECRET = process.env.AUTH_COOKIE_SECRET || "troque-este-segredo-em-producao";

function signSession(email) {
  const payload = Buffer.from(email, "utf-8").toString("base64url");
  const signature = crypto.createHmac("sha256", COOKIE_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

/** Retorna o email da sessão se a assinatura bater, ou null. */
function verifySession(cookieValue) {
  if (!cookieValue) return null;
  const [payload, signature] = cookieValue.split(".");
  if (!payload || !signature) return null;

  const expected = crypto.createHmac("sha256", COOKIE_SECRET).update(payload).digest("base64url");
  const actual = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (actual.length !== expectedBuf.length || !crypto.timingSafeEqual(actual, expectedBuf)) {
    return null;
  }

  return Buffer.from(payload, "base64url").toString("utf-8");
}

function parseCookies(header) {
  if (!header) return {};
  return Object.fromEntries(
    header
      .split(";")
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const idx = pair.indexOf("=");
        return [decodeURIComponent(pair.slice(0, idx)), decodeURIComponent(pair.slice(idx + 1))];
      }),
  );
}

module.exports = { signSession, verifySession, parseCookies };
