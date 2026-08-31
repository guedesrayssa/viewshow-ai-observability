// Constrói a imagem da API e publica no ECR.
//
// Existe como script Node, e não como comando embutido no Terraform, porque
// precisa rodar igual em Linux, macOS e Windows. Um heredoc de bash com
// `set -euo pipefail` não funciona no PowerShell nem no cmd; `node script.mjs`
// funciona nos três sem adaptação.
//
// Recebe tudo por variável de ambiente, preenchida pelo bloco `environment` do
// provisioner (que o Terraform repassa de forma portável).

import { spawnSync } from "node:child_process";

const { REGIAO, REPO_URL, TAG, CONTEXTO } = process.env;

for (const [nome, valor] of Object.entries({ REGIAO, REPO_URL, TAG, CONTEXTO })) {
  if (!valor) {
    console.error(`variável de ambiente ausente: ${nome}`);
    process.exit(1);
  }
}

const imagem = `${REPO_URL}:${TAG}`;
const registro = REPO_URL.split("/")[0];

/**
 * Executa um comando repassando a saída para o terminal.
 *
 * `shell: false` evita depender da sintaxe do interpretador — sem isso, um
 * argumento com espaço se comportaria de um jeito no bash e de outro no cmd.
 */
function executar(comando, argumentos, opcoes = {}) {
  const resultado = spawnSync(comando, argumentos, {
    stdio: ["inherit", "inherit", "inherit"],
    shell: false,
    ...opcoes,
  });

  if (resultado.error) {
    console.error(`falha ao executar ${comando}: ${resultado.error.message}`);
    if (resultado.error.code === "ENOENT") {
      console.error(`${comando} não está instalado ou não está no PATH.`);
    }
    process.exit(1);
  }

  if (resultado.status !== 0) {
    console.error(`${comando} terminou com código ${resultado.status}`);
    process.exit(resultado.status ?? 1);
  }

  return resultado;
}

/** Igual ao anterior, mas devolve a saída em vez de imprimi-la. */
function capturar(comando, argumentos) {
  const resultado = spawnSync(comando, argumentos, { encoding: "utf-8", shell: false });

  if (resultado.error || resultado.status !== 0) {
    console.error(resultado.stderr || resultado.error?.message || "falha desconhecida");
    process.exit(1);
  }

  return resultado.stdout.trim();
}

console.log(`autenticando no ECR (${registro})`);
const senha = capturar("aws", ["ecr", "get-login-password", "--region", REGIAO]);

// A senha entra por stdin, nunca como argumento: argumentos de processo são
// legíveis por qualquer usuário da máquina via /proc ou Gerenciador de Tarefas.
executar("docker", ["login", "--username", "AWS", "--password-stdin", registro], {
  input: senha,
  stdio: ["pipe", "inherit", "inherit"],
});

// --platform linux/amd64 é obrigatório: Fargate roda x86_64, e um build feito
// num Mac Apple Silicon sairia arm64 e a task morreria no start com
// "exec format error".
console.log(`construindo ${imagem}`);
executar("docker", ["build", "--platform", "linux/amd64", "-t", imagem, "."], {
  cwd: CONTEXTO,
});

console.log(`publicando ${imagem}`);
executar("docker", ["push", imagem]);

console.log("imagem publicada");
