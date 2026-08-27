const { verifySession, parseCookies } = require("../auth/session");

/** Exige cookie de sessão válido. Usado nas rotas que escrevem em recursos
 * sensíveis (ex: confirmar hipótese, que pode promover um caso à golden set). */
function requireAuth(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const email = verifySession(cookies.session);
  if (!email) {
    return res.status(401).json({ error: { message: "Sessão inválida ou ausente" } });
  }
  req.userEmail = email;
  next();
}

module.exports = requireAuth;
