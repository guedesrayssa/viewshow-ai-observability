// O painel no Amplify Hosting, publicado por deployment manual (zip), do mesmo
// jeito que artefatos/sprint2/ci-cd-amplify.md descreve: o app é criado sem
// --repository, porque o Amplify Hosting só conecta GitHub, Bitbucket,
// GitLab.com e CodeCommit, e o GitLab do Inteli é auto-hospedado.

resource "aws_amplify_app" "painel" {
  name     = var.nome_app_amplify
  platform = "WEB"

  // ---------------------------------------------------------------------------
  // As três regras abaixo são o que faz o login funcionar.
  //
  // ci-cd-amplify.md registra como limitação conhecida que "enquanto a API
  // responder em http://<ip> (sem TLS)" a sessão não funciona em produção. A
  // configuração atual em apps/backend/api/src/app.ts emite o cookie com
  // secure=true quando NODE_ENV=production e sameSite=lax. Painel em HTTPS no
  // Amplify e API em HTTP no ALB são sites
  // diferentes e esquemas diferentes: o navegador bloqueia a chamada por
  // conteúdo misto antes de sair, e mesmo que passasse, sameSite=lax não
  // anexaria o cookie.
  //
  // O Amplify sabe fazer proxy reverso (status 200). Encaminhando /api, /auth e
  // /health para o ALB (via API Gateway, porque o Amplify exige alvo
  // HTTPS e o ALB não tem certificado — ver apigateway.tf), o navegador vê tudo saindo de uma origem só, em HTTPS:
  // conteúdo misto desaparece, CORS desaparece, sameSite=lax volta a valer e
  // secure=true passa a ser aplicável. A identidade continua fail-closed até
  // existir um adaptador corporativo real; estas regras preservam a sessão
  // same-origin para quando ele for integrado.
  // ---------------------------------------------------------------------------

  custom_rule {
    source = "/api/<*>"
    target = "${local.api_gateway_base_url}/api/<*>"
    status = "200"
  }

  custom_rule {
    source = "/auth/<*>"
    target = "${local.api_gateway_base_url}/auth/<*>"
    status = "200"
  }

  custom_rule {
    source = "/health"
    target = "${local.api_gateway_base_url}/health"
    status = "200"
  }

  tags = {
    Projeto = "view-show"
  }
}

resource "aws_amplify_branch" "principal" {
  app_id      = aws_amplify_app.painel.id
  branch_name = var.branch_amplify

  tags = {
    Projeto = "view-show"
  }
}

locals {
  frontend_dir         = "${path.module}/../frontend"
  painel_url           = "https://${aws_amplify_branch.principal.branch_name}.${aws_amplify_app.painel.default_domain}"
  api_gateway_base_url = trimsuffix(aws_apigatewayv2_stage.default.invoke_url, "/")

  // Manifesto determinístico de tudo que o build de produção consome.
  // node_modules, .next, out, testes e documentação ficam de fora.
  arquivos_build_frontend = sort(concat(
    [
      "next.config.ts",
      "package-lock.json",
      "package.json",
      "postcss.config.mjs",
      "tsconfig.json",
    ],
    tolist(fileset(local.frontend_dir, "app/**")),
    tolist(fileset(local.frontend_dir, "components/**")),
    tolist(fileset(local.frontend_dir, "hooks/**")),
    tolist(fileset(local.frontend_dir, "lib/**")),
    tolist(fileset(local.frontend_dir, "public/**")),
  ))

  hash_frontend = sha1(join("", [
    for arquivo in local.arquivos_build_frontend : "${arquivo}:${filesha1("${local.frontend_dir}/${arquivo}")}\n"
  ]))
}

// Build, empacotamento e publicação do painel.
//
// Três etapas separadas de propósito: a do meio é o `archive_file`, que é
// nativo do Terraform e monta o zip igual nos três sistemas — evita depender do
// utilitário `zip`, que não existe numa instalação limpa de Windows.
//
// NEXT_PUBLIC_API_BASE_URL="/" só funciona por causa do ajuste em
// lib/data/client.ts, lib/auth.ts e evidencias/evidence-resource.ts: o Next
// embute o valor dessa variável nos bundles em tempo de compilação, então sem
// resolver "/" para window.location.origin no navegador, cada endereço novo de
// API exigiria recompilar o painel inteiro.
resource "terraform_data" "build_painel" {
  triggers_replace = [local.hash_frontend]

  // `&&` encadeia igual no sh e no cmd, e as variáveis vão pelo bloco
  // `environment` em vez do prefixo `VAR=valor`, que é sintaxe só de shell
  // POSIX. Assim a linha vale para Linux, macOS e Windows sem ramificação.
  provisioner "local-exec" {
    command     = "npm ci --no-audit --no-fund && npm run build"
    working_dir = local.frontend_dir

    environment = {
      // O build precisa de saída para fonts.googleapis.com: app/layout.tsx usa
      // next/font/google. As fontes acabam self-hosted no bundle, mas a máquina
      // que compila precisa alcançar o Google.
      NEXT_PUBLIC_API_BASE_URL           = "/"
      NEXT_PUBLIC_TELEMETRY_API_BASE_URL = "/"
    }
  }
}

// Lido só depois que o build existir: o `depends_on` adia a leitura para o
// apply, senão o Terraform tentaria zipar out/ durante o plan, antes de a pasta
// existir.
data "archive_file" "painel" {
  type        = "zip"
  source_dir  = "${local.frontend_dir}/out"
  output_path = "${path.module}/.terraform-artifacts/painel.zip"

  depends_on = [terraform_data.build_painel]
}

resource "terraform_data" "painel" {
  triggers_replace = [
    data.archive_file.painel.output_sha256,
    aws_amplify_branch.principal.arn,
  ]

  provisioner "local-exec" {
    command = "node ${abspath("${path.module}/scripts/publicar-painel.mjs")}"

    environment = {
      APP_ID = aws_amplify_app.painel.id
      BRANCH = aws_amplify_branch.principal.branch_name
      REGIAO = var.regiao
      ZIP    = abspath(data.archive_file.painel.output_path)
    }
  }
}
