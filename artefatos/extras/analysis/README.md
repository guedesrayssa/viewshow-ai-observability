# Análise do Dump Argus

Este laboratório explora uma cópia local do dump MySQL do Argus. Os notebooks são somente de leitura, preservam a distinção entre UTC e BRT e limitam cada DataFrame a 100.000 linhas.

> **Importante:** Execute todos os comandos abaixo a partir do diretório `artefatos/extras/analysis/`.

---

## Pré-requisitos

- **Python 3.10+** instalado
- **Docker** e **Docker Compose**
- **Cliente MySQL** (ou Git Bash / WSL caso esteja no Windows)

---

## 1. Ambiente Local

Substitua apenas as senhas locais no `.env` gerado (arquivo não versionado).
- `ARGUS_DATABASE_URL`: Aponta para o dump local
- `ARGUS_TEST_DATABASE_URL`: Banco isolado de teste
- `ARGUS_MAX_ROWS`: Teto de resultados por DataFrame
- `ARGUS_DISPLAY_TIMEZONE`: Fuso de apresentação

### macOS / Linux / WSL (Bash)

```bash
# Criação do venv e instalação de dependências
python3 -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'

# Configuração de variáveis e subida do banco
cp .env.example .env
docker compose up -d mysql
```

### Windows (PowerShell)

```powershell
# Criação do venv e instalação de dependências
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e '.[dev]'

# Configuração de variáveis e subida do banco
copy .env.example .env
docker compose up -d mysql
```

---

## 2. Importação Manual do Dump

A importação é manual, observável e exige espaço em disco e tempo consideráveis. Evite rodar a importação, testes amplos e servidores simultaneamente.

> ⚠️ **Atenção quanto ao caminho do arquivo:** O caminho `../../../../dados/argus_dump.sql.gz` nos comandos abaixo é um exemplo baseado na estrutura relativa a partir de `artefatos/extras/analysis/`. **Caso você tenha extraído o ZIP em outra pasta ou salvo o dump em outro diretório**, altere o caminho para refletir o local correto na sua máquina.

### macOS / Linux / Git Bash / WSL

```bash
# Ajuste o caminho do arquivo .sql.gz conforme o local onde você salvou/extraiu o dump
gzip -dc ../../../../dados/argus_dump.sql.gz \
  | mysql --host=127.0.0.1 --port=3307 --user=argus -p argus
```

### Windows (PowerShell puro)

Se não estiver usando Git Bash ou WSL, descompacte o arquivo previamente ou utilize o próprio container Docker para a ingestão:

```powershell
# Caso tenha o arquivo .sql descompactado (ajuste o caminho para onde o arquivo está salvo):
Get-Content ../../../../dados/argus_dump.sql | docker exec -i (docker compose ps -q mysql) mysql -u argus -p argus
```

---

## 3. Fixture Isolado e Smoke Test

O fixture é sanitizado e recria somente tabelas mínimas em `argus_test` (nunca aceita `argus` como alvo).

### macOS / Linux / WSL

```bash
docker compose up -d mysql
python scripts/load_test_fixture.py

ARGUS_TEST_DATABASE_URL="mysql+pymysql://root:change-root-me@127.0.0.1:3307/argus_test?charset=utf8mb4" \
pytest tests/integration/test_notebooks.py -v
```

### Windows (PowerShell)

```powershell
docker compose up -d mysql
python scripts/load_test_fixture.py

$env:ARGUS_TEST_DATABASE_URL="mysql+pymysql://root:change-root-me@127.0.0.1:3307/argus_test?charset=utf8mb4"
pytest tests/integration/test_notebooks.py -v
```

*Nota: Se `ARGUS_TEST_DATABASE_URL` não for definida, o smoke test será ignorado exibindo o comando de preparação.*

---

## 4. Notebooks e Execução

Certifique-se de que o seu ambiente virtual está ativo (`source .venv/bin/activate` ou `.\.venv\Scripts\Activate.ps1`) e inicie a interface:

```bash
jupyter lab
```

### Ordem de Execução Recomendada

1. `00_catalogo_dataset`
2. `01_cobertura_qualidade`
3. `02_sinais_normalizados`
4. `03_infraestrutura_qos`
5. `04_experiencia_qoe`
6. `05_incidentes_rca`
7. `06_eventos_ao_vivo`
8. `07_contrato_ingestao`

### Manutenção e Testes

- **Regenerar notebooks limpos** (sem saídas ou execução salvas no versionamento):
  ```bash
  python scripts/build_notebooks.py all
  ```
- **Executar testes unitários e de higiene:**
  ```bash
  pytest -q
  ```