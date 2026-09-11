// O AWS Academy bloqueia s3:GetBucketObjectLockConfiguration por SCP. O
// recurso aws_s3_bucket sempre chama essa API durante o refresh, mesmo sem
// Object Lock, então a criação e a remoção do bucket ficam sob terraform_data.
// As configurações de segurança continuam em recursos AWS declarativos.

import { spawnSync } from "node:child_process";

const { ACTION, BUCKET, REGIAO } = process.env;

for (const [nome, valor] of Object.entries({ ACTION, BUCKET, REGIAO })) {
  if (!valor) {
    console.error(`variável de ambiente ausente: ${nome}`);
    process.exit(1);
  }
}

if (!new Set(["create", "delete"]).has(ACTION)) {
  console.error(`ação inválida: ${ACTION}`);
  process.exit(1);
}

function executar(argumentos, { permitirAusente = false } = {}) {
  const resultado = spawnSync("aws", [...argumentos, "--region", REGIAO], {
    encoding: "utf8",
    shell: false,
  });

  if (resultado.error) {
    console.error(resultado.error.message);
    process.exit(1);
  }

  if (resultado.status !== 0) {
    const mensagem = `${resultado.stderr}\n${resultado.stdout}`;
    if (
      permitirAusente &&
      /NoSuchBucket|Not Found|status code:\s*404|StatusCode:\s*404/i.test(mensagem)
    ) {
      return false;
    }
    console.error(resultado.stderr.trim() || resultado.stdout.trim());
    process.exit(resultado.status ?? 1);
  }

  return true;
}

const existe = executar(
  ["s3api", "get-bucket-location", "--bucket", BUCKET],
  { permitirAusente: true },
);

if (ACTION === "create") {
  if (!existe) {
    executar(["s3api", "create-bucket", "--bucket", BUCKET]);
  }

  executar([
    "s3api",
    "put-bucket-tagging",
    "--bucket",
    BUCKET,
    "--tagging",
    JSON.stringify({
      TagSet: [
        { Key: "Name", Value: BUCKET },
        { Key: "Camada", Value: "observabilidade" },
        { Key: "Projeto", Value: "view-show" },
        { Key: "Stack", Value: "g05-sprint3-entrega" },
        { Key: "ManagedBy", Value: "terraform" },
      ],
    }),
  ]);

  console.log(existe ? "bucket existente adotado" : "bucket criado");
  process.exit(0);
}

if (!existe) {
  console.log("bucket já removido");
  process.exit(0);
}

executar(["s3", "rm", `s3://${BUCKET}`, "--recursive"]);
executar(["s3api", "delete-bucket", "--bucket", BUCKET]);
console.log("bucket removido");
