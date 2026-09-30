// Constrói a imagem e publica no ECR. Serve tanto a API (ecr.tf) quanto a
// ingestão (ingestion-runtime.tf); o repositório e o contexto vêm por ambiente.
//
// Existe como script Node, e não como comando embutido no Terraform, porque
// precisa rodar igual em Linux, macOS e Windows. Um heredoc de bash com
// `set -euo pipefail` não funciona no PowerShell nem no cmd; `node script.mjs`
// funciona nos três sem adaptação.
//
// Recebe tudo por variável de ambiente, preenchida pelo bloco `environment` do
// provisioner (que o Terraform repassa de forma portável).

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const VARIAVEIS_OBRIGATORIAS = ["REGIAO", "REPO_URL", "TAG", "CONTEXTO"];

/**
 * Executa um comando e devolve status e saídas, sem abortar o processo.
 *
 * `shell: false` evita depender da sintaxe do interpretador — sem isso, um
 * argumento com espaço se comportaria de um jeito no bash e de outro no cmd.
 */
function executar(comando, argumentos, opcoes = {}) {
  const resultado = spawnSync(comando, argumentos, {
    encoding: "utf-8",
    shell: false,
    ...opcoes,
  });

  if (resultado.error) {
    const detalhe =
      resultado.error.code === "ENOENT"
        ? `${comando} não está instalado ou não está no PATH.`
        : resultado.error.message;
    throw new Error(`falha ao executar ${comando}: ${detalhe}`);
  }

  return resultado;
}

const executarAws = (argumentos) => executar("aws", argumentos);
const executarDocker = (argumentos, opcoes = {}) =>
  executar("docker", argumentos, { stdio: ["inherit", "inherit", "inherit"], ...opcoes });

function exigir(resultado, comando) {
  if (resultado.status !== 0) {
    // A saída de erro do aws/docker não carrega o token: `capturar` só é usado
    // em comandos cujo stderr descreve a falha, não a credencial.
    throw new Error(
      `${comando} terminou com código ${resultado.status}: ${(resultado.stderr || "").trim()}`,
    );
  }
  return resultado;
}

/**
 * Publica a imagem, ou adota a que já está no registro.
 *
 * A tag deriva do hash das fontes e o repositório é `IMMUTABLE`, então a mesma
 * tag só pode descrever a mesma árvore de código. Um `apply` interrompido logo
 * depois do push deixaria a tag publicada; reconstruir gera outro digest de
 * manifest (o image config carrega `created`) e o push colidiria com
 * `ImageTagAlreadyExistsException`, travando a retentativa — num runbook que
 * proíbe remover imagem à mão para compensar interrupção. Por isso a
 * existência da tag é consultada antes de construir.
 */
export function publicarImagem(ambiente = process.env, executores = {}) {
  const { aws = executarAws, docker = executarDocker } = executores;

  for (const nome of VARIAVEIS_OBRIGATORIAS) {
    if (!ambiente[nome]) throw new Error(`variável de ambiente ausente: ${nome}`);
  }

  const { REGIAO, REPO_URL, TAG, CONTEXTO } = ambiente;
  const imagem = `${REPO_URL}:${TAG}`;
  const registro = REPO_URL.split("/")[0];
  const repositorio = REPO_URL.split("/").slice(1).join("/");

  console.log(`autenticando no ECR (${registro})`);
  const senha = exigir(
    aws(["ecr", "get-login-password", "--region", REGIAO]),
    "aws ecr get-login-password",
  ).stdout.trim();

  // A senha entra por stdin, nunca como argumento: argumentos de processo são
  // legíveis por qualquer usuário da máquina via /proc ou Gerenciador de Tarefas.
  exigir(
    docker(["login", "--username", "AWS", "--password-stdin", registro], {
      input: senha,
      stdio: ["pipe", "inherit", "inherit"],
    }),
    "docker login",
  );

  const existente = aws([
    "ecr",
    "describe-images",
    "--region",
    REGIAO,
    "--repository-name",
    repositorio,
    "--image-ids",
    `imageTag=${TAG}`,
  ]);
  if (existente.status === 0) {
    console.log(`imagem ${imagem} já publicada; adotando sem reconstruir`);
    return "adopted";
  }

  // --platform linux/amd64 é obrigatório: os nós EKS usam x86_64, e um build feito
  // num Mac Apple Silicon sairia arm64 e a task morreria no start com
  // "exec format error".
  console.log(`construindo ${imagem}`);
  exigir(
    docker(["build", "--platform", "linux/amd64", "-t", imagem, "."], { cwd: CONTEXTO }),
    "docker build",
  );

  console.log(`publicando ${imagem}`);
  exigir(docker(["push", imagem]), "docker push");

  console.log("imagem publicada");
  return "published";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    publicarImagem();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
