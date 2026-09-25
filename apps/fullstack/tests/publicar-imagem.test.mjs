import assert from "node:assert/strict";
import test from "node:test";

import { publicarImagem } from "../scripts/publicar-imagem.mjs";

const baseAmbiente = {
  REGIAO: "us-east-1",
  REPO_URL: "123456789012.dkr.ecr.us-east-1.amazonaws.com/view-show-ingestion",
  TAG: "abc123def456",
  CONTEXTO: "/tmp/contexto",
};

function falsosExecutores({ tagExistente = false } = {}) {
  const chamadas = [];
  const aws = (argumentos) => {
    chamadas.push(["aws", ...argumentos]);
    if (argumentos[1] === "get-login-password") {
      return { status: 0, stdout: "senha-do-registro\n", stderr: "" };
    }
    if (argumentos[1] === "describe-images") {
      return tagExistente
        ? { status: 0, stdout: '{"imageDetails":[{}]}', stderr: "" }
        : { status: 254, stdout: "", stderr: "ImageNotFoundException" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const docker = (argumentos, opcoes = {}) => {
    chamadas.push(["docker", ...argumentos, ...(opcoes.input ? ["<stdin>"] : [])]);
    return { status: 0, stdout: "", stderr: "" };
  };
  return { chamadas, aws, docker };
}

test("publica a imagem quando a tag ainda não existe no repositório", () => {
  const executores = falsosExecutores({ tagExistente: false });

  const resultado = publicarImagem(baseAmbiente, executores);

  assert.equal(resultado, "published");
  const acoesDocker = executores.chamadas
    .filter(([binario]) => binario === "docker")
    .map(([, subcomando]) => subcomando);
  assert.deepEqual(acoesDocker, ["login", "build", "push"]);
});

test("adota a imagem existente sem republicar quando a tag já está no repositório", () => {
  // A tag é imutável no ECR (image_tag_mutability = "IMMUTABLE") e deriva do
  // hash das fontes. Um apply interrompido depois do push deixaria a tag no
  // registro; sem esta adoção, a retentativa reconstrói, gera outro digest de
  // manifest e o push colide com ImageTagAlreadyExistsException, travando o
  // apply num procedimento que proíbe remoção manual de imagem.
  const executores = falsosExecutores({ tagExistente: true });

  const resultado = publicarImagem(baseAmbiente, executores);

  assert.equal(resultado, "adopted");
  const acoesDocker = executores.chamadas
    .filter(([binario]) => binario === "docker")
    .map(([, subcomando]) => subcomando);
  assert.ok(!acoesDocker.includes("push"), "não deve republicar uma tag imutável já existente");
  assert.ok(!acoesDocker.includes("build"), "não deve reconstruir uma imagem já publicada");
});

test("consulta o repositório pelo nome derivado da URL, não pela URL inteira", () => {
  const executores = falsosExecutores({ tagExistente: true });

  publicarImagem(baseAmbiente, executores);

  const consulta = executores.chamadas.find(
    ([binario, , subcomando]) => binario === "aws" && subcomando === "describe-images",
  );
  assert.ok(consulta, "deve consultar o ECR antes de publicar");
  assert.ok(consulta.includes("view-show-ingestion"));
  assert.ok(!consulta.some((argumento) => argumento.includes("dkr.ecr")));
  assert.ok(consulta.includes("imageTag=abc123def456"));
});

test("nunca passa a senha do registro como argumento de processo", () => {
  const executores = falsosExecutores();

  publicarImagem(baseAmbiente, executores);

  for (const chamada of executores.chamadas) {
    for (const argumento of chamada) {
      assert.ok(
        !argumento.includes("senha-do-registro"),
        `senha vazou em argumento: ${chamada.join(" ")}`,
      );
    }
  }
  const login = executores.chamadas.find(
    ([binario, subcomando]) => binario === "docker" && subcomando === "login",
  );
  assert.ok(login.includes("--password-stdin"));
  assert.ok(login.includes("<stdin>"), "a senha precisa entrar por stdin");
});

test("recusa antes de qualquer efeito quando falta variável de ambiente", () => {
  const executores = falsosExecutores();
  const { TAG: _omitida, ...incompleto } = baseAmbiente;

  assert.throws(() => publicarImagem(incompleto, executores), /TAG/);
  assert.deepEqual(executores.chamadas, []);
});
