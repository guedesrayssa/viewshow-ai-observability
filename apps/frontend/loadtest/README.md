# Testes da entrega estática e renderização do frontend

Requer Node.js **22.19+** e Chrome/Chrome for Testing para Lighthouse. As versões
Autocannon 8.0.0, Lighthouse 13.5.0, Chrome Launcher 1.2.1 e serve 14.2.5 estão
fixadas no lockfile. O teste não autentica usuários nem mede a API do painel.

## Preparar a exportação

Na pasta `apps/frontend`:

```bash
npm ci
npm run test:loadtest
NEXT_PUBLIC_API_BASE_URL=/ npm run build -- --webpack
npx serve out --listen tcp://127.0.0.1:4173 --no-request-logging --no-port-switching
```

Use um servidor exclusivamente para esta rodada. Os logs de cada requisição
ficam desligados para evitar que o terminal seja o limitante da carga local.

## Auditorias Lighthouse sequenciais

```bash
LIGHTHOUSE_URL=http://127.0.0.1:4173/login/ \
RESULTS_DIR=../../assets/testes-carga/<data>-frontend npm run loadtest:lighthouse
```

Opcionalmente defina `CHROME_PATH` com o executável Chrome for Testing. O runner
abre um Chrome e perfil isolados por auditoria, espera a coleta e o encerramento
antes da próxima, e faz três desktop e três móveis. Não execute Autocannon,
build ou outra auditoria durante essa etapa. Datas, revisão, versão, configuração
e SHA-256 de cada relatório ficam em `lighthouse-executions.json`.
Uma métrica principal ausente, não finita ou com erro (incluindo `NO_LCP`)
interrompe a execução; zero TBT/CLS é uma medida válida.

## Carga e recuperação na mesma intensidade

Depois de terminar o Lighthouse:

```bash
BASE_URL=http://127.0.0.1:4173 OUT_DIR=out \
RESULTS_DIR=../../assets/testes-carga/<data>-frontend \
SERVER_PID=<pid-do-servidor> npm run loadtest:battery
```

`SERVER_PID` é opcional e permite registrar que o mesmo processo permanece vivo.
A bateria aguarda cada comando e inicia o seguinte sem sleep: smoke (2 conexões,
15 s), carga (50, 60 s), pico (200, 30 s) e **recuperação na carga de 50 conexões
por 60 s**. A recuperação começa após o preflight obrigatório e seu intervalo
fica registrado, permitindo distinguir recuperação imediata de uma pausa manual.
Uma reprovação não impede medir a recuperação; a bateria retorna código 1 se
algum cenário reprovou e preserva os resultados em `environment.json`.

Perfis individuais continuam disponíveis:

```bash
BASE_URL=http://127.0.0.1:4173 OUT_DIR=out PROFILE=smoke npm run loadtest:static
BASE_URL=http://127.0.0.1:4173 OUT_DIR=out PROFILE=load npm run loadtest:static
BASE_URL=http://127.0.0.1:4173 OUT_DIR=out PROFILE=spike npm run loadtest:static
```

No PowerShell use `$env:BASE_URL`, `$env:PROFILE` e demais variáveis. Sem
`RESULTS_DIR`, resultados locais ficam no diretório ignorado `loadtest/results/`.

## Validação de conteúdo e critérios

O preflight valida as sete páginas e todos os recursos Next.js descobertos:
status 200, tipo de conteúdo, corpo não vazio e ausência de HTML como arquivo
estático. Com `OUT_DIR`, cada resposta é comparada por SHA-256 com a exportação
local. MIME/corpo também são verificados em **cada resposta durante a carga**;
isso reprova um fallback HTML introduzido depois do preflight. O resultado
contém as URLs e fingerprints, sem armazenar o conteúdo dos arquivos.

Os thresholds exigem zero erros de transporte, timeout, não-2xx ou conteúdo
inválido e p97,5 abaixo de 200 ms. Controle negativo 200/HTML e conteúdo que
muda durante a execução têm testes reais com Autocannon em servidores locais
descartáveis. Não é um teste funcional completo do JavaScript; renderização
e dados autenticados têm cenários próprios.

O servidor e o gerador compartilham CPU. Compare rodadas equivalentes no mesmo
ambiente; os números não dimensionam o Amplify nem devem ser comparados
diretamente com outra máquina, auditor ou configuração de logging.
