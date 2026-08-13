<table>
  <tr>
    <td><a href="https://www.inteli.edu.br/"><img src="logo-inteli.png" alt="Inteli" width="140"></a></td>
    <td align="right"><img src="logo-globo.png" alt="Globo" width="140"></td>
  </tr>
</table>

# Plataforma de Telemetria de Frontend do Globoplay

**Grupo 05** — Módulo 7, Engenharia de Software — Inteli
**Parceiro:** Globo

## Integrantes

- João Freitas
- Marcos Marcondes
- Messias Olivindo
- Raiane Brandão
- Rayssa Guedes França
- Victor Santos

## Descrição do projeto

As plataformas de monitoração de mercado pressupõem protocolos modernos e um
parque de dispositivos homogêneo, o que deixa de fora justamente a base real do
Globoplay: Smart TVs fabricadas entre 2013 e 2026, com pouca capacidade de
processamento e sem suporte aos SDKs atuais de telemetria — de modo que falhas
de reprodução nesses aparelhos só chegam à engenharia pelo relato do usuário,
sem dado que permita diagnosticar a causa. A solução é uma plataforma
proprietária de telemetria que recebe eventos de reprodução, erros e sinais de
presença emitidos por qualquer frontend, normaliza tudo em um formato único e
expõe indicadores de qualidade de experiência e de falhas por meio de uma API de
consulta e de um painel, permitindo que as equipes de engenharia e observabilidade
enxerguem a degradação enquanto ela acontece, em vez de depois do fato.

## Estrutura de pastas

| Pasta | Conteúdo |
| --- | --- |
| `/artefatos` | Documentação: requisitos, arquitetura do backend, análise financeira, roteiro de implantação na AWS, relatório de testes e a coleção do Postman |
| `/apps/basica` | Aplicação da Sprint 1: `backend` (API em Flask), `frontend` (painel estático) e `deploy` (artefatos de implantação) |
| `/assets` | Imagens usadas na documentação |
| `/slides` | Apresentações das sprints |

## Execução local

Requer **Python 3.10 ou superior** e um navegador. Nada além disso: o painel é
HTML, CSS e JavaScript servidos como estão, sem etapa de build.

```bash
git clone https://git.inteli.edu.br/graduacao/2026-2a/t15/g05.git
cd g05/apps/basica/backend

python3 -m venv .venv
source .venv/bin/activate          # no Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt

python wsgi.py                     # API em http://127.0.0.1:5000
```

Em outro terminal, popule a base e sirva o painel:

```bash
cd apps/basica/backend
.venv/bin/python scripts/seed_demo.py          # dados de demonstração

cd ../frontend
python3 -m http.server 5173                    # painel em http://localhost:5173
```

O painel já vem apontado para `http://localhost:5000`. Para apontá-lo a outra
API, altere `API_BASE_URL` em `apps/basica/frontend/config.js` — é o único
arquivo que muda entre ambientes.

Sem configuração adicional a API guarda os dados em memória, e eles somem ao
reiniciar. Para persistir no DynamoDB, veja
[`artefatos/backend.md`](artefatos/backend.md).

### Testes

```bash
cd apps/basica/backend
.venv/bin/python -m unittest discover -s tests -t .   # 160 testes
.venv/bin/ruff check . && .venv/bin/ruff format --check .
```

Os testes de GET e POST da API estão na coleção do Postman em
[`artefatos/postman`](artefatos/postman). Importe a coleção e o ambiente
`local`, ou rode pela linha de comando:

```bash
npx newman run artefatos/postman/telemetria-globoplay.postman_collection.json \
    -e artefatos/postman/local.postman_environment.json
```

### GitHub Codespaces

Abra o repositório em um Codespace e execute os mesmos comandos acima. O
Codespace já traz Python 3 e Node; as portas 5000 e 5173 são encaminhadas
automaticamente, e o painel funciona pela URL pública encaminhada sem nenhum
ajuste, porque a API libera CORS para qualquer origem no modo padrão.

## Execução na AWS

A aplicação roda com a API em uma instância **EC2**, os dados no **DynamoDB** e
o painel publicado como site estático em um bucket **S3**.

O passo a passo completo — criação da instância, Elastic IP, provisionamento da
tabela, serviço do systemd, bucket, CORS e verificação final — está em
[`artefatos/deploy-aws.md`](artefatos/deploy-aws.md).

Resumo dos comandos, com a infraestrutura já criada:

```bash
# na instância EC2
sudo cp apps/basica/deploy/telemetria.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now telemetria

# na máquina local, publica o painel apontado para a API
cd apps/basica/deploy
./deploy-frontend.sh <nome-do-bucket> http://<ip-da-ec2>
```

Como o ambiente é um laboratório da AWS Academy, cuja sessão encerra após quatro
horas, a instância é configurada com Elastic IP e com o serviço habilitado no
systemd. Isso faz a API voltar sozinha, no mesmo endereço, bastando iniciar a
instância na sessão seguinte.

## Documentação adicional

- [Arquitetura e endpoints do backend](artefatos/backend.md)
- [Especificação de requisitos](artefatos/requisitos.md)
- [Roteiro de implantação na AWS](artefatos/deploy-aws.md)
- [Análise financeira](artefatos/analise_financeira.md)
