"""Gera notebooks estáticos para exploração segura do dump Argus."""

import argparse
from pathlib import Path

from dump_explorer.notebook_builder import write_notebook

NOTEBOOK_IDENTIFIERS = ("00", "01", "02", "03", "04", "05", "06", "07")


def build_notebook(identifier: str, path: Path | None = None) -> Path:
    """Gera o notebook identificado sem executar suas células."""
    if identifier == "07":
        return _build_ingestion_contract_notebook(path)
    if identifier == "06":
        return _build_live_events_notebook(path)
    if identifier == "05":
        return _build_incidents_rca_notebook(path)
    if identifier == "04":
        return _build_qoe_notebook(path)
    if identifier == "03":
        return _build_infrastructure_qos_notebook(path)
    if identifier == "02":
        return _build_normalized_signals_notebook(path)
    if identifier == "01":
        return _build_quality_notebook(path)
    if identifier != "00":
        raise ValueError(f"Notebook não suportado: {identifier}")

    target = path or Path(__file__).parents[1] / "notebooks" / "00_catalogo_dataset.ipynb"
    return write_notebook(
        target,
        "Catálogo do dataset Argus",
        [
            (
                "markdown",
                """## Escopo da exploração

Este notebook explora o dump MySQL local do Argus. Ele não consulta BigQuery:
o dump é uma fotografia local e pode diferir da fonte analítica em cobertura e
atualização.""",
            ),
            (
                "code",
                """from dump_explorer.catalog import (
    EXPECTED_TABLES,
    compare_expected_tables,
    load_column_catalog,
    load_table_catalog,
)
from dump_explorer.charts import volume_bar
from dump_explorer.config import load_settings
from dump_explorer.database import create_db_engine

settings = load_settings()
engine = create_db_engine(settings)""",
            ),
            (
                "markdown",
                "## Catálogos disponíveis\n\nAs estimativas abaixo vêm dos metadados do MySQL.",
            ),
            (
                "code",
                """table_catalog = load_table_catalog(engine)
column_catalog = load_column_catalog(engine)

display(table_catalog)
display(column_catalog)""",
            ),
            (
                "markdown",
                "## Cobertura documentada\n\nCompare o dump com a lista esperada pelo laboratório.",
            ),
            (
                "code",
                """table_coverage = compare_expected_tables(
    actual=table_catalog["table_name"].tolist(),
    expected=EXPECTED_TABLES,
)
display(table_coverage)""",
            ),
            (
                "markdown",
                """## Volume por tabela

O gráfico está marcado como **estimativa do MySQL**. Contagens exatas não são computadas
para tabelas grandes, para preservar o dump e evitar consultas caras.""",
            ),
            ("code", "volume_bar(table_catalog).show()"),
        ],
    )


def build_all_notebooks(output_dir: Path | None = None) -> list[Path]:
    """Generate every versioned notebook in stable numeric order."""
    directory = output_dir or Path(__file__).parents[1] / "notebooks"
    return [
        build_notebook(identifier, directory / f"{identifier}_{name}.ipynb")
        for identifier, name in (
            ("00", "catalogo_dataset"),
            ("01", "cobertura_qualidade"),
            ("02", "sinais_normalizados"),
            ("03", "infraestrutura_qos"),
            ("04", "experiencia_qoe"),
            ("05", "incidentes_rca"),
            ("06", "eventos_ao_vivo"),
            ("07", "contrato_ingestao"),
        )
    ]


def _build_ingestion_contract_notebook(path: Path | None = None) -> Path:
    """Gera o notebook que documenta o contrato lógico antes do schema físico."""
    target = path or Path(__file__).parents[1] / "notebooks" / "07_contrato_ingestao.ipynb"
    return write_notebook(
        target,
        "Contrato lógico de ingestão BigQuery",
        [
            (
                "markdown",
                """## Escopo e limite de evidência

Este catálogo documenta os campos lógicos que uma futura ingestão precisa
receber. Ele **não** consulta BigQuery e não supõe projeto, dataset, tabela,
coluna, partição, watermark ou regra de atualização. Tudo que depende do schema
físico permanece como `não fornecido` até validação da Globo.

As fontes ServiceNow e NPAW/Youbora são domínios documentados via BigQuery. Os
seis campos de `frontend_events_sample` usam
`source_system="amostra frontend; origem BigQuery não comprovada"`: vêm de
exemplos de frontend e ficam separados do contrato confirmado.""",
            ),
            (
                "code",
                """from dump_explorer.contract import (
    FRONTEND_SAMPLE_SOURCE,
    OUTPUTS_DIR,
    UNKNOWN_PHYSICAL_MAPPING,
    build_logical_contract,
    export_contract_csv,
    validate_physical_mapping,
)

contract = build_logical_contract()
physical_columns = [
    "bigquery_table",
    "bigquery_column",
    "bigquery_partition_column",
    "bigquery_write_watermark",
    "update_semantics",
]""",
            ),
            (
                "markdown",
                "## 1. Campos lógicos de domínios documentados via BigQuery\n\n"
                "NPAW tem atraso estrutural de aproximadamente 28 horas. Em ServiceNow, "
                "`opened_at` é ticket-open time, não o início do incidente.",
            ),
            (
                "code",
                """confirmed_domains = contract.loc[
    contract["source_system"] != FRONTEND_SAMPLE_SOURCE
]
display(confirmed_domains)

domain_summary = confirmed_domains.groupby(
    ["source_system", "logical_table", "grain", "known_delay"], as_index=False
).size()
display(domain_summary)""",
            ),
            (
                "markdown",
                "## 2. Amostras de eventos de frontend\n\n"
                "A seção abaixo não é um mapeamento BigQuery e não autoriza ingestão de "
                "identificadores individuais. Ela registra apenas os campos lógicos "
                "selecionados dos seis exemplos fornecidos.",
            ),
            (
                "code",
                """frontend_samples = contract.loc[
    contract["source_system"] == FRONTEND_SAMPLE_SOURCE
]
display(frontend_samples)""",
            ),
            (
                "markdown",
                "## 3. Lacunas do mapeamento físico\n\n"
                "A validação não converte nomes do dump MySQL em nomes físicos BigQuery. "
                "Ela torna explícitas as lacunas que bloqueiam uma ingestão incremental "
                "segura e idempotente.",
            ),
            (
                "code",
                """unresolved_physical_fields = contract.loc[
    contract[physical_columns].eq(UNKNOWN_PHYSICAL_MAPPING).any(axis=1)
]
issues = validate_physical_mapping(contract)
display(unresolved_physical_fields)
display([issue.__dict__ for issue in issues])""",
            ),
            (
                "markdown",
                "## 4. Exportação explícita\n\n"
                "Nenhum CSV é criado ao abrir ou executar este notebook. Para exportar, "
                "altere conscientemente a flag abaixo; o destino é restringido a "
                "`analysis/outputs`.",
            ),
            (
                "code",
                """export_csv = False
if export_csv:
    output_path = OUTPUTS_DIR / "contrato_logico_ingestao.csv"
    exported_path = export_contract_csv(contract, output_path)
    print(f"Contrato exportado para {exported_path}")""",
            ),
            (
                "markdown",
                """## Perguntas exatas para enviar à Globo

1. Qual é o **project/dataset/table** físico para cada domínio?
2. Qual é a **partition column** de cada tabela?
3. Qual é o **write watermark** confiável?
4. Qual é a **natural key** de idempotência?
5. Como são tratados **late arrivals**?
6. Como são tratados **corrections/deletes**?
7. Como a **schema evolution** é comunicada e compatibilizada?
8. Quais campos têm **PII** e quais regras de sanitização se aplicam?
9. Quais são as **query quotas** e limites de custo/leitura?""",
            ),
        ],
    )


def _build_incidents_rca_notebook(path: Path | None = None) -> Path:
    """Gera o notebook de contexto de incidentes e evidências de RCA."""
    target = path or Path(__file__).parents[1] / "notebooks" / "05_incidentes_rca.ipynb"
    return write_notebook(
        target,
        "Incidentes e evidências de RCA do dump Argus",
        [
            (
                "markdown",
                """## Escopo, tempo e limites metodológicos

`opened_at` é a hora **ticket-open**, não o início do incidente. A linha do
tempo usa uma banda visual de **40 minutos** de incerteza sem alterar o
timestamp armazenado. A ausência de ticket não é rótulo negativo de ausência
de problema: incidentes podem não ser registrados ou ser registrados tarde.

O escopo padrão `video` usa somente `incidents`. `platform` é um universo de
times vizinhos e só deve ser consultado explicitamente, sem misturar ambos na
avaliação.""",
            ),
            (
                "code",
                """from dump_explorer.charts import (
    attribution_stack,
    incident_timeline,
    provenance_bar,
)
from dump_explorer.config import load_settings
from dump_explorer.database import create_db_engine
from dump_explorer.rca import (
    build_incident_window,
    load_dashboard_artifact,
    load_error_attribution,
    load_incidents,
    load_labels,
)

settings = load_settings()
engine = create_db_engine(settings)
start_ms = 0  # substitua por início UTC em epoch ms
end_ms = 86_400_000  # substitua por fim UTC em epoch ms""",
            ),
            (
                "markdown",
                """## 1. Tickets estruturados e cobertura de telemetria

O leitor só expõe prioridade, estado, duração registrada e componentes
estruturados; texto livre sanitizado não é exibido. Compare a cobertura de
ticket-open com a cobertura de telemetria para investigar lacunas, não para
inferir que uma das fontes causou a outra.""",
            ),
            (
                "code",
                """incidents = load_incidents(engine, start_ms, end_ms, scope="video")
attribution = load_error_attribution(engine, start_ms, end_ms)

display(incidents[["opened_at", "priority", "state", "duration_ms"]])
display(
    {
        "ticket_open_rows": len(incidents),
        "telemetry_rows": len(attribution),
        "ticket_open_min": incidents["opened_at"].min() if not incidents.empty else None,
        "telemetry_min": attribution["timestamp"].min() if not attribution.empty else None,
    }
)""",
            ),
            (
                "markdown",
                """## 2. Janela de evidência

Os offsets permitidos são 15m, 30m, 1h, 2h e 6h. O contexto reúne ticket,
deploy e atribuição de erros no tempo; a sobreposição é evidência para
investigação, não prova de causalidade.""",
            ),
            (
                "code",
                """if not incidents.empty:
    context = build_incident_window(engine, incidents.iloc[0], before="1h", after="1h")
    incident_timeline(context.incident.to_frame().T, context.deploys, context.signals).show()
    attribution_stack(context.attribution).show()
    display(context.labels)
else:
    print("Sem ticket na janela: isso não é uma evidência negativa de incidente.")""",
            ),
            (
                "markdown",
                """## 3. Golden set e proveniência

Por padrão, a avaliação usa apenas `rca-confirmed` e `team-confirmed`.
`detector-derived` pode aparecer na visualização, mas é marcado como circular:
ele mede concordância com o detector que o criou, não acurácia independente.""",
            ),
            (
                "code",
                """confirmed_labels = load_labels(engine)
display(confirmed_labels)
provenance_bar(confirmed_labels).show()

# Somente para inspeção visual; não use este conjunto como ground truth.
detector_display = load_labels(engine, provenances=["detector-derived"])
provenance_bar(detector_display).show()""",
            ),
            (
                "markdown",
                """## 4. Comparação opcional com artefatos Argus

Um artefato só é lido por nome exato e seu JSON precisa ser um objeto. Esta
comparação é **opcional**: associe-o a um rótulo humano apenas se ambos trouxerem
um identificador compartilhado explícito. Não faça associação por título,
texto parecido ou proximidade temporal.""",
            ),
            (
                "code",
                """artifact_name = "incidents"  # nome exato, altere conscientemente
artifact = load_dashboard_artifact(engine, artifact_name)
display(artifact)

# Sem identificador compartilhado explícito, mantenha artefato e rótulos separados.""",
            ),
        ],
    )


def _build_infrastructure_qos_notebook(path: Path | None = None) -> Path:
    """Gera o notebook de exploração de QoS das fontes de infraestrutura."""
    target = path or Path(__file__).parents[1] / "notebooks" / "03_infraestrutura_qos.ipynb"
    return write_notebook(
        target,
        "Infraestrutura e QoS do dump Argus",
        [
            (
                "markdown",
                """## Escopo, janela e limites

Cada leitura usa a janela UTC explícita `[start, end)` e parâmetros vinculados.
Os loaders limitam cada DataFrame a no máximo 100.000 linhas; `prom_point` nunca
é lida sem antes selecionar uma seção e no máximo 20 séries.""",
            ),
            (
                "code",
                """from dump_explorer.charts import event_overlay_timeline, qos_small_multiples
from dump_explorer.config import load_settings
from dump_explorer.database import create_db_engine
from dump_explorer.qos import (
    load_apollo,
    load_cloudarmor,
    load_newrelic,
    load_prometheus,
    load_rpaas,
    load_tsuru_events,
)

settings = load_settings()
engine = create_db_engine(settings)
start_ms = 0  # substitua por início UTC em epoch ms
end_ms = 86_400_000  # substitua por fim UTC em epoch ms""",
            ),
            (
                "markdown",
                """## 1. New Relic e Apollo

Apdex tem direção `lower_is_worse`. Em Apollo, `request_count` é contagem por
linha: `rpm` usa a duração real de cada janela, que não é fixa.""",
            ),
            (
                "code",
                """newrelic_apps = []  # opcional: nomes de aplicações
apollo_operations = []  # opcional: operações GraphQL

newrelic = load_newrelic(engine, newrelic_apps, start_ms, end_ms)
apollo = load_apollo(engine, apollo_operations, start_ms, end_ms)
qos_small_multiples(newrelic).show()
qos_small_multiples(apollo).show()""",
            ),
            (
                "markdown",
                """## 2. RPaaS e Cloud Armor

RPaaS é amostrado a **1%**: as contagens são amostras, não tráfego absoluto, e
as taxas (`5xx/total`) são mais comparáveis. A taxa 4xx é contextual; somente
os vhosts de playback recebem `playback_signal=True`. Um aparente pico de
memória em Prometheus pode ser o limite do **cgroup** (por exemplo,
`gg-gateway-rpaas-be`), e não uso real de memória.""",
            ),
            (
                "code",
                """rpaas_regions = []  # opcional: ["br1"]
rpaas_vhosts = []  # opcional: ["playback.video.globo.com"]
cloudarmor_apps = []  # opcional: aplicações protegidas

rpaas = load_rpaas(engine, rpaas_regions, rpaas_vhosts, start_ms, end_ms)
cloudarmor = load_cloudarmor(engine, cloudarmor_apps, start_ms, end_ms)
qos_small_multiples(rpaas).show()
qos_small_multiples(cloudarmor).show()""",
            ),
            (
                "markdown",
                """## 3. Seções selecionadas do Prometheus

Escolha explicitamente as seções e, se necessário, serviços. O limite de 20
séries é aplicado antes do join com `prom_point`; não use a seção para inferir
semântica sem verificar o painel e os labels.""",
            ),
            (
                "code",
                """prometheus_sections = ["RPAASV2 CPU"]  # selecione seções de interesse
prometheus_services = []  # opcional: services
technical_for_events = None

for section in prometheus_sections:
    prom_section = load_prometheus(
        engine, section, prometheus_services, start_ms, end_ms, limit_series=20
    )
    qos_small_multiples(prom_section).show()
    if technical_for_events is None:
        technical_for_events = prom_section""",
            ),
            (
                "markdown",
                """## 4. Eventos Tsuru sobrepostos

`autoscale.run` significa reaplicação de regra (`rule_reapplication`), não
prova de escala por demanda. A sobreposição temporal é contexto para
investigação, não evidência de causalidade. Campos sanitizados como owner e
error permanecem nulos.""",
            ),
            (
                "code",
                """tsuru_targets = []  # opcional: nomes de apps/pools
tsuru_events = load_tsuru_events(engine, tsuru_targets, start_ms, end_ms)
if technical_for_events is not None:
    event_overlay_timeline(technical_for_events, tsuru_events).show()
display(tsuru_events.head())""",
            ),
        ],
    )


def _build_quality_notebook(path: Path | None = None) -> Path:
    """Gera o notebook de cobertura, cadência e saúde dos coletores."""
    target = path or Path(__file__).parents[1] / "notebooks" / "01_cobertura_qualidade.ipynb"
    return write_notebook(
        target,
        "Cobertura e qualidade do dump Argus",
        [
            (
                "markdown",
                """## Escopo e fuso horário

Os timestamps apresentados por este notebook estão em **UTC**. O BRT
(`America/Sao_Paulo`) deve ser aplicado apenas na visualização, nunca como
interpretação implícita dos dados de origem.""",
            ),
            (
                "code",
                """from dump_explorer.charts import (
    cadence_histogram,
    collector_timeline,
    coverage_heatmap,
    missingness_bar,
)
from dump_explorer.config import load_settings
from dump_explorer.database import create_db_engine
from dump_explorer.quality import (
    load_collector_health,
    load_missingness,
    load_series_cadence,
    load_source_coverage,
    load_source_daily_coverage,
    load_table_coverage,
)

settings = load_settings()
engine = create_db_engine(settings)""",
            ),
            (
                "markdown",
                "## 1. coverage by table\n\n"
                "Tabelas grandes usam estimativas; não há COUNT completo nelas.",
            ),
            (
                "code",
                "table_coverage = load_table_coverage(engine)\ndisplay(table_coverage)",
            ),
            (
                "markdown",
                "## 2. Cobertura por signal_bucket.source\n\n"
                "As épocas em milissegundos são convertidas para UTC.",
            ),
            (
                "code",
                "source_coverage = load_source_coverage(engine)\ndisplay(source_coverage)",
            ),
            (
                "markdown",
                "## 3. source x day heatmap\n\n"
                "Escolha uma janela finita em UTC para não executar varredura ampla.",
            ),
            (
                "code",
                """heatmap_start_ms = 0  # substitua por início UTC em epoch ms
heatmap_end_ms = 86_400_000  # substitua por fim UTC em epoch ms
source_day = load_source_daily_coverage(engine, heatmap_start_ms, heatmap_end_ms)
coverage_heatmap(source_day, x="day", y="source", value="rows").show()""",
            ),
            (
                "markdown",
                "## 4. Cadência para uma série selecionada\n\n"
                "A série usa source, entity, metric e [start, end).",
            ),
            (
                "code",
                """series_source = "newrelic"
series_entity = "service-name"
series_metric = "error_rate_pct"
series_start_ms = 0  # substitua por início UTC em epoch ms
series_end_ms = 86_400_000  # substitua por fim UTC em epoch ms
cadence = load_series_cadence(
    engine, series_source, series_entity, series_metric, series_start_ms, series_end_ms
)
cadence_histogram(cadence).show()""",
            ),
            (
                "markdown",
                "## 5. Resumo de nulos e desconhecidos\n\n"
                "Zero medido, nulo e ausência de bucket são estados distintos.",
            ),
            (
                "code",
                """small_table = "signal_bucket"
small_columns = ["source", "entity", "metric"]
missingness = load_missingness(engine, small_table, small_columns)
display(missingness)
missingness_bar(missingness).show()""",
            ),
            (
                "markdown",
                "## 6. Execuções dos coletores\n\nExecuções `incomplete` não têm `finished_at`.",
            ),
            (
                "code",
                """collector_health = load_collector_health(engine
)
display(collector_health)
collector_timeline(collector_health).show()""",
            ),
            (
                "markdown",
                """## 7. Watermark e chegadas tardias

NPAW apresenta aproximadamente **28 horas** de atraso estrutural. Portanto,
o watermark deve preservar uma janela de releitura para chegadas tardias. A
ausência de tickets não é um rótulo negativo confiável: pode refletir falta de
abertura, coleta ou cobertura, e não ausência do incidente.""",
            ),
        ],
    )


def _build_normalized_signals_notebook(path: Path | None = None) -> Path:
    """Gera o notebook de exploração das identidades normalizadas de sinais."""
    target = path or Path(__file__).parents[1] / "notebooks" / "02_sinais_normalizados.ipynb"
    return write_notebook(
        target,
        "Sinais normalizados do dump Argus",
        [
            (
                "markdown",
                """## Identidade natural e escopo

Uma métrica isolada não identifica uma série: `error_rate`, por exemplo, pode
existir em várias origens e entidades. Toda leitura usa a identidade completa
**source, entity, metric** e uma janela explícita `[start, end)` em UTC.""",
            ),
            (
                "code",
                """import plotly.graph_objects as go
from IPython.display import display
from ipywidgets import Dropdown, Output

from dump_explorer.charts import (
    METRIC_DIRECTION,
    correlation_heatmap,
    metric_timeline,
    source_metric_heatmap,
)
from dump_explorer.config import load_settings
from dump_explorer.database import create_db_engine
from dump_explorer.signals import (
    list_series,
    load_correlation_frame,
    load_metric_series,
    load_source_distribution,
)

settings = load_settings()
engine = create_db_engine(settings)
start_ms = 0  # substitua por início UTC em epoch ms
end_ms = 86_400_000  # substitua por fim UTC em epoch ms""",
            ),
            (
                "markdown",
                "## 1. Distribuição por source, entity e metric\n\n"
                "A janela é obrigatória e limitada; o notebook não faz varredura temporal "
                "implícita.",
            ),
            (
                "code",
                """source_distribution = load_source_distribution(engine, start_ms, end_ms)
display(source_distribution)

selected_source = source_distribution.iloc[0]["source"] if not source_distribution.empty else None
series_catalog = (
    list_series(engine, selected_source, start_ms, end_ms) if selected_source is not None else None
)
if series_catalog is not None:
    display(series_catalog)
    source_metric_heatmap(series_catalog).show()""",
            ),
            (
                "markdown",
                "## 2. Seletor interativo de série\n\n"
                "A seleção sempre preserva source, entity e metric; ela não escolhe apenas a "
                "métrica.",
            ),
            (
                "code",
                """series_options = [] if series_catalog is None else [
    (f"{row.source} | {row.entity} | {row.metric}", (row.source, row.entity, row.metric))
    for row in series_catalog.itertuples(index=False)
]
series_selector = Dropdown(options=series_options, description="Série:")
series_output = Output()
display(series_selector, series_output)

def render_selected_series(change=None):
    if series_selector.value is None:
        return
    source, entity, metric = series_selector.value
    selected_series = load_metric_series(engine, source, entity, metric, start_ms, end_ms)
    with series_output:
        series_output.clear_output(wait=True)
        metric_timeline(selected_series, metric=metric).show()
        display(selected_series.head())
    return selected_series

series_selector.observe(render_selected_series, names="value")
selected_series = render_selected_series()""",
            ),
            (
                "markdown",
                "## 3. Volume em 15 minutos e distribuição de valores\n\n"
                "O agrupamento abaixo conta observações por 15 minutos explicitamente; "
                "os valores da série não são reamostrados.",
            ),
            (
                "code",
                """if selected_series is not None:
    volume_15min = (
        selected_series.assign(bucket_15min=selected_series["timestamp"].dt.floor("15min"))
        .groupby("bucket_15min", as_index=False)
        .size()
    )
    go.Figure(go.Bar(x=volume_15min["bucket_15min"], y=volume_15min["size"])).update_layout(
        title="Volume de observações por 15 minutos", xaxis_title="UTC", yaxis_title="Observações"
    ).show()
    go.Figure(go.Histogram(x=selected_series["value"])).update_layout(
        title="Distribuição dos valores observados", xaxis_title="Valor", yaxis_title="Frequência"
    ).show()""",
            ),
            (
                "markdown",
                "## 4. Direção de degradação\n\n`METRIC_DIRECTION` apenas explica a direction "
                "da degradação: os valores armazenados nunca são invertidos. Métricas "
                "desconhecidas são `context_dependent`.",
            ),
            ("code", "display(METRIC_DIRECTION)"),
            (
                "markdown",
                "## 5. Correlação de séries selecionadas explicitamente\n\nEscolha até 20 "
                "identidades completas. Lacunas permanecem ausentes: a correlação não "
                "preenche valores faltantes com zero.",
            ),
            (
                "code",
                """correlation_keys = [
    # ("newrelic", "service-name", "error_rate_pct"),
    # ("prometheus", "service-name", "latency_p95"),
]
correlation_frame = load_correlation_frame(engine, correlation_keys, start_ms, end_ms)
display(correlation_frame)
correlation_heatmap(correlation_frame).show()""",
            ),
        ],
    )


def _build_qoe_notebook(path: Path | None = None) -> Path:
    """Gera o notebook de experiência agregada do usuário, sem identificadores individuais."""
    target = path or Path(__file__).parents[1] / "notebooks" / "04_experiencia_qoe.ipynb"
    return write_notebook(
        target,
        "Experiência do usuário e QoE do dump Argus",
        [
            (
                "markdown",
                """## Escopo e atraso conhecido

Estas tabelas NPAW/Youbora são agregadas por hora x dimensão e não expõem IDs
individuais. Cada consulta usa uma janela UTC explícita `[start, end)`. Há um
atraso estrutural de aproximadamente **28 horas**: a cobertura mais recente pode
estar vazia ou parcial por desenho do pipeline, e não é evidência de ausência de
incidente em tempo real.""",
            ),
            (
                "code",
                """from dump_explorer.charts import (
    category_stack,
    geo_heatmap,
    impact_scatter,
    qoe_timeline,
)
from dump_explorer.config import load_settings
from dump_explorer.database import create_db_engine
from dump_explorer.qoe import (
    NPAW_DELAY_HOURS,
    load_device_qoe,
    load_error_categories,
    load_geo_qoe,
    load_live_active,
    load_live_qoe,
    load_player_qoe,
)

settings = load_settings()
engine = create_db_engine(settings)
start_ms = 0  # substitua por início UTC em epoch ms
end_ms = 86_400_000  # substitua por fim UTC em epoch ms""",
            ),
            (
                "markdown",
                """## 1. Players, dispositivos e geografia

`(desconhecido)` é uma dimensão ausente explicitamente marcada, não removida do
ranking. A taxa de erro é `NULL` quando sessões é zero. Dispositivos usam pelo
menos 30 sessões **na consulta SQL**; o ranking não representa a cardinalidade
bruta. O heatmap UF x ISP usa somente agregados locais, sem mapa ou ativos externos.""",
            ),
            (
                "code",
                """player_qoe = load_player_qoe(engine, start_ms, end_ms)
device_qoe = load_device_qoe(engine, start_ms, end_ms, min_sessions=30)
geo_qoe = load_geo_qoe(engine, start_ms, end_ms)
display(player_qoe)
display(device_qoe)
display(geo_qoe)
impact_scatter(player_qoe, dimension="player").show()
impact_scatter(device_qoe, dimension="device").show()
geo_heatmap(geo_qoe).show()""",
            ),
            (
                "markdown",
                """## 2. QoE ao vivo e audiência

Selecione sinais explicitamente. `bufferratio` é **ratio**, `jointime` é em
**segundos** e latência é em **milissegundos**; as unidades não compartilham eixo.
`startup_errors` fica separado de erros durante a reprodução. `active_sessions`
é uma contagem de sessões **concorrentes**, não acumulada; `joins_in_bucket`
significa novas entradas no bucket de 15 minutos.""",
            ),
            (
                "code",
                """signals = ["pfc1"]  # selecione explicitamente um ou mais sinais
live_qoe = load_live_qoe(engine, signals, start_ms, end_ms)
live_active = load_live_active(engine, signals, start_ms, end_ms)
latest_qoe_timestamp = live_active["timestamp"].max() if not live_active.empty else None
print(
    f"Timestamp NPAW mais recente: {latest_qoe_timestamp}; "
    f"cobertura pode atrasar cerca de {NPAW_DELAY_HOURS} horas."
)
display(live_qoe)
display(live_active)
qoe_timeline(live_qoe, metric="startup_errors").show()
qoe_timeline(live_qoe, metric="bufferratio_avg").show()
qoe_timeline(live_qoe, metric="jointime_s_avg").show()
qoe_timeline(live_active, metric="active_sessions").show()""",
            ),
            (
                "markdown",
                """## 3. Categorias semânticas de erro

Live e VOD são carregados e visualizados separadamente; não existe taxa única
misturando os dois. `top_names` preserva o texto bruto e recebe uma flag quando
o JSON está inválido.""",
            ),
            (
                "code",
                """live_categories = load_error_categories(engine, "live", start_ms, end_ms)
vod_categories = load_error_categories(engine, "vod", start_ms, end_ms)
display(live_categories)
display(vod_categories)
category_stack(live_categories).show()
category_stack(vod_categories).show()""",
            ),
        ],
    )


def _build_live_events_notebook(path: Path | None = None) -> Path:
    """Gera o notebook que compara confrontos EPG com audiência e QoE agregada."""
    target = path or Path(__file__).parents[1] / "notebooks" / "06_eventos_ao_vivo.ipynb"
    return write_notebook(
        target,
        "Eventos ao vivo, audiência e QoE do dump Argus",
        [
            (
                "markdown",
                """## Escopo, identidade e limites de comparação

O EPG identifica um confronto por `event_key`; `tid` permanece visível como a
identidade do feed. Slots simultâneos não são fundidos pelo horário de início.
Cada leitura usa o intervalo EPG completo e uma janela de audiência/QoE de **15 minutos**,
com 60 minutos antes e depois apenas para contexto.

O slug `globo` é associado à família `globo%`, uma aproximação nacional marcada
como `national_family_approximation`. Outros slugs usam correspondência exata.
A ausência de telemetria para uma linha do EPG é exibida como
`telemetry_available=False`; especialmente para slots futuros ou cobertura QoE
atrasada, isso não é um incidente.""",
            ),
            (
                "code",
                """import pandas as pd

from dump_explorer.charts import event_audience_timeline, event_impact_scatter, qoe_timeline
from dump_explorer.config import load_settings
from dump_explorer.database import create_db_engine
from dump_explorer.live import (
    build_event_comparison,
    distinct_event_count,
    load_event_audience,
    load_live_events,
)

settings = load_settings()
engine = create_db_engine(settings)
start_ms = 0  # substitua por início UTC em epoch ms
end_ms = 86_400_000  # substitua por fim UTC em epoch ms""",
            ),
            (
                "markdown",
                "## 1. Catálogo EPG e confrontos distintos\n\n"
                "A contagem usa `event_key`; `tid` mantém a identidade do feed.",
            ),
            (
                "code",
                """epg_events = load_live_events(engine, start_ms, end_ms)
display(epg_events)
display({"distinct_confrontations": distinct_event_count(epg_events)})""",
            ),
            (
                "markdown",
                """## 2. Audiência antes, durante e depois do evento

Escolha confrontos explicitamente. Os pontos são sessões ativas concorrentes,
não entradas acumuladas. O slot EPG recebe 60 minutos de contexto de cada lado.""",
            ),
            (
                "code",
                """event_keys = []  # selecione event_key(s) vistos no catálogo EPG
timelines = [load_event_audience(engine, key, padding_minutes=60) for key in event_keys]
event_timeline = pd.concat(timelines, ignore_index=True) if timelines else pd.DataFrame()
display(event_timeline)
if not event_timeline.empty:
    event_audience_timeline(event_timeline).show()""",
            ),
            (
                "markdown",
                """## 3. Erros, buffering e join time

`active_with_error` representa sessões ativas com erro; buffering é ratio e
`jointime_s_avg` é em segundos. Só trace pontos com `telemetry_available=True`;
não preencha lacunas com zero.""",
            ),
            (
                "code",
                """if not event_timeline.empty:
    observed = event_timeline.loc[event_timeline["telemetry_available"]]
    if not observed.empty:
        qoe_timeline(observed, metric="active_with_error").show()
        qoe_timeline(observed, metric="bufferratio_avg").show()
        qoe_timeline(observed, metric="jointime_s_avg").show()
    else:
        print("O EPG foi encontrado, mas não há telemetria disponível nesta janela.")""",
            ),
            (
                "markdown",
                """## 4. Comparação entre confrontos

A comparação conserva feeds com EPG sem telemetria. O gráfico posiciona somente
confrontos observados e anota os demais; sobreposição temporal não prova causalidade.""",
            ),
            (
                "code",
                """if event_keys:
    comparison = build_event_comparison(engine, event_keys)
    display(comparison)
    event_impact_scatter(comparison).show()
else:
    print("Selecione event_key(s) para comparar audiência e QoE.")""",
            ),
        ],
    )


def main() -> None:
    """Lê o identificador solicitado e grava o notebook correspondente."""
    parser = argparse.ArgumentParser()
    parser.add_argument("identifier", choices=[*NOTEBOOK_IDENTIFIERS, "all"])
    args = parser.parse_args()
    if args.identifier == "all":
        build_all_notebooks()
    else:
        build_notebook(args.identifier)


if __name__ == "__main__":
    main()
