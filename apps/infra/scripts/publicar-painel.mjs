// Publica o painel já compilado e empacotado no Amplify, e espera a publicação
// terminar.
//
// O Amplify Hosting não tem recurso de Terraform para deployment manual — o app
// e a branch são criados nativamente (amplify.tf), mas o envio do conteúdo
// passa por três chamadas de API. Este script faz essas três, e existe em Node
// pelo mesmo motivo do publicar-imagem.mjs: roda igual nos três sistemas.
//
// O zip não é criado aqui: quem monta é o `archive_file` do Terraform, que é
// nativo e portável. Aqui só se envia.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const { APP_ID, BRANCH, REGIAO, ZIP } = process.env;

for (const [nome, valor] of Object.entries({ APP_ID, BRANCH, REGIAO, ZIP })) {
  if (!valor) {
    console.error(`variável de ambiente ausente: ${nome}`);
    process.exit(1);
  }
}

function aws(argumentos) {
  const resultado = spawnSync("aws", [...argumentos, "--region", REGIAO], {
    encoding: "utf-8",
    shell: false,
  });

  if (resultado.error) {
    if (resultado.error.code === "ENOENT") {
      console.error("o AWS CLI não está instalado ou não está no PATH.");
    } else {
      console.error(resultado.error.message);
    }
    process.exit(1);
  }

  if (resultado.status !== 0) {
    console.error(resultado.stderr.trim());
    process.exit(resultado.status ?? 1);
  }

  return resultado.stdout.trim();
}

const espera = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 1. Reserva um job e recebe a URL assinada para onde enviar o zip.
const [jobId, urlEnvio] = aws([
  "amplify", "create-deployment",
  "--app-id", APP_ID,
  "--branch-name", BRANCH,
  "--query", "[jobId,zipUploadUrl]",
  "--output", "text",
]).split(/\s+/);

// 2. Envia o zip. `fetch` é global desde o Node 18, então não precisa de curl —
// que não existe em toda instalação de Windows.
const conteudo = readFileSync(ZIP);
const resposta = await fetch(urlEnvio, {
  method: "PUT",
  body: conteudo,
  headers: { "Content-Type": "application/zip" },
});

if (!resposta.ok) {
  console.error(`falha ao enviar o zip: HTTP ${resposta.status} ${resposta.statusText}`);
  process.exit(1);
}

// 3. Dispara a publicação.
aws([
  "amplify", "start-deployment",
  "--app-id", APP_ID,
  "--branch-name", BRANCH,
  "--job-id", jobId,
]);

// Espera terminar. Sem isto o apply devolveria uma URL que ainda responde 404.
for (let tentativa = 0; tentativa < 60; tentativa += 1) {
  const status = aws([
    "amplify", "get-job",
    "--app-id", APP_ID,
    "--branch-name", BRANCH,
    "--job-id", jobId,
    "--query", "job.summary.status",
    "--output", "text",
  ]);

  if (status === "SUCCEED") {
    console.log("painel publicado");
    process.exit(0);
  }

  if (status === "FAILED" || status === "CANCELLED") {
    console.error(`publicação terminou como ${status}`);
    process.exit(1);
  }

  await espera(5000);
}

console.error("tempo esgotado esperando a publicação do painel");
process.exit(1);
