// Limite 180/min, NODE_ENV=production (trust proxy 1). XFF simula a cadeia API GW -> ALB: "<cliente>, <egress do API GW>".
const BASE = "http://127.0.0.1:3000";
async function burst(label, xffFor, n) {
  const tally = {};
  for (let i = 0; i < n; i++) {
    const r = await fetch(BASE + "/auth/session", { headers: { "X-Forwarded-For": xffFor(i) } });
    tally[r.status] = (tally[r.status] || 0) + 1;
  }
  console.log(label.padEnd(70), JSON.stringify(tally));
}
// 200 usuários DISTINTOS (cliente varia) atrás do MESMO egress do gateway (extremo direito igual)
await burst("200 req, clientes distintos, mesmo egress do gateway (203.0.113.9):", (i) => `198.51.100.${i % 250}, 203.0.113.9`, 200);
// depois, um usuário totalmente diferente, mesmo egress:
const r = await fetch(BASE + "/auth/session", { headers: { "X-Forwarded-For": "192.0.2.77, 203.0.113.9" } });
console.log("usuário novo, mesmo egress ->", r.status, "(429 = bucket compartilhado)");
const r2 = await fetch(BASE + "/auth/session", { headers: { "X-Forwarded-For": "192.0.2.77, 203.0.113.10" } });
console.log("usuário novo, OUTRO egress  ->", r2.status);
