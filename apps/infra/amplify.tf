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
  // responder em http://<ip> (sem TLS)" o login não funciona em produção. A
  // causa são duas linhas em src/routes/auth.js: o cookie de sessão sai com
  // secure=true (NODE_ENV=production está cravado no Dockerfile) e
  // sameSite=lax. Painel em HTTPS no Amplify e API em HTTP no ALB são sites
  // diferentes e esquemas diferentes: o navegador bloqueia a chamada por
  // conteúdo misto antes de sair, e mesmo que passasse, sameSite=lax não
  // anexaria o cookie.
  //
  // O Amplify sabe fazer proxy reverso (status 200). Encaminhando /api, /auth e
  // /health para o ALB (via API Gateway, porque o Amplify exige alvo
  // HTTPS e o ALB não tem certificado — ver apigateway.tf), o navegador vê tudo saindo de uma origem só, em HTTPS:
  // conteúdo misto desaparece, CORS desaparece, sameSite=lax volta a valer e
  // secure=true passa a ser verdade. Nada disso exige tocar no código da
  // aplicação nem trocar a arquitetura — só usa uma capacidade do Amplify que
  // já estava disponível.
  // ---------------------------------------------------------------------------

  custom_rule {
    source = "/api/<*>"
    target = "https://${replace(aws_apigatewayv2_stage.default.invoke_url, "https://", "")}/api/<*>"
    status = "200"
  }

  custom_rule {
    source = "/auth/<*>"
    target = "https://${replace(aws_apigatewayv2_stage.default.invoke_url, "https://", "")}/auth/<*>"
    status = "200"
  }

  custom_rule {
    source = "/health"
    target = "https://${replace(aws_apigatewayv2_stage.default.invoke_url, "https://", "")}/health"
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
  frontend_dir = "${path.module}/../frontend"
  painel_url   = "https://${aws_amplify_branch.principal.branch_name}.${aws_amplify_app.painel.default_domain}"

  // Só o que entra no build. node_modules e .next ficam de fora.
  hash_frontend = sha1(join("", [
    filesha1("${local.frontend_dir}/package.json"),
    filesha1("${local.frontend_dir}/package-lock.json"),
    filesha1("${local.frontend_dir}/next.config.ts"),
    sha1(join("", [for f in fileset(local.frontend_dir, "app/**") : filesha1("${local.frontend_dir}/${f}")])),
    sha1(join("", [for f in fileset(local.frontend_dir, "components/**") : filesha1("${local.frontend_dir}/${f}")])),
    sha1(join("", [for f in fileset(local.frontend_dir, "lib/**") : filesha1("${local.frontend_dir}/${f}")])),
    sha1(join("", [for f in fileset(local.frontend_dir, "hooks/**") : filesha1("${local.frontend_dir}/${f}")])),
  ]))
}

// Build, zip e publicação do painel.
//
// NEXT_PUBLIC_API_BASE_URL="/" só funciona por causa do ajuste em
// lib/data/client.ts, lib/auth.ts e evidencias/evidence-resource.ts: o Next
// embute o valor dessa variável nos bundles em tempo de compilação, então sem
// resolver "/" para window.location.origin no navegador, cada endereço novo de
// API exigiria recompilar o painel inteiro.
resource "terraform_data" "painel" {
  triggers_replace = [
    local.hash_frontend,
    aws_amplify_branch.principal.arn,
    // Rebuild quando a flag de dado de exemplo mudar: ela também é inlined.
    var.permitir_dado_exemplo,
  ]

  provisioner "local-exec" {
    working_dir = local.frontend_dir
    interpreter = ["bash", "-c"]

    command = <<-EOT
      set -euo pipefail

      npm ci --no-audit --no-fund

      # O build precisa de saída para fonts.googleapis.com: app/layout.tsx usa
      # next/font/google. As fontes acabam self-hosted no bundle, mas a máquina
      # que compila precisa alcançar o Google.
      NEXT_PUBLIC_API_BASE_URL=/ \
      NEXT_PUBLIC_TELEMETRY_API_BASE_URL=/ \
      NEXT_PUBLIC_ALLOW_EXAMPLE_DATA=${var.permitir_dado_exemplo ? "true" : "false"} \
        npm run build

      test -d out || { echo "build nao gerou out/ — output:'export' saiu do next.config.ts?" >&2; exit 1; }

      rm -f painel.zip
      (cd out && zip -qr ../painel.zip .)

      read -r JOB_ID UPLOAD_URL <<< "$(aws amplify create-deployment \
        --app-id ${aws_amplify_app.painel.id} \
        --branch-name ${aws_amplify_branch.principal.branch_name} \
        --region ${var.regiao} \
        --query '[jobId,zipUploadUrl]' --output text)"

      curl --silent --show-error --fail -X PUT --upload-file painel.zip "$UPLOAD_URL"

      aws amplify start-deployment \
        --app-id ${aws_amplify_app.painel.id} \
        --branch-name ${aws_amplify_branch.principal.branch_name} \
        --job-id "$JOB_ID" \
        --region ${var.regiao} >/dev/null

      # Espera a publicação terminar, senão o apply devolve uma URL que ainda
      # responde 404.
      for _ in $(seq 1 40); do
        STATUS="$(aws amplify get-job \
          --app-id ${aws_amplify_app.painel.id} \
          --branch-name ${aws_amplify_branch.principal.branch_name} \
          --job-id "$JOB_ID" --region ${var.regiao} \
          --query 'job.summary.status' --output text)"
        case "$STATUS" in
          SUCCEED) echo "painel publicado"; rm -f painel.zip; exit 0 ;;
          FAILED|CANCELLED) echo "publicacao falhou: $STATUS" >&2; exit 1 ;;
        esac
        sleep 5
      done

      echo "tempo esgotado esperando a publicacao" >&2
      exit 1
    EOT
  }
}
