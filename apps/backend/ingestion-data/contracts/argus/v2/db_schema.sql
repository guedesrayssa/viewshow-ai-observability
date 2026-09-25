CREATE TABLE signal_bucket (
    bts     BIGINT       NOT NULL,                  -- epoch_ms do bucket de 15min (floor)
    source  VARCHAR(64)  NOT NULL,
    entity  VARCHAR(255) NOT NULL,
    metric  VARCHAR(128) NOT NULL,
    value   DOUBLE       NOT NULL,
    PRIMARY KEY (source, entity, metric, bts),
    KEY ix_signal_bucket_bts (bts)                  -- range read [detect_start,end) + prune
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE signal_meta (
    source           VARCHAR(64) NOT NULL,
    last_ingested_ts BIGINT,                          -- epoch_ms UTC
    last_run_at      VARCHAR(32),                     -- ISO-8601 (metadata; não-partição)
    rows_total       BIGINT DEFAULT 0,
    rows_last_run    BIGINT DEFAULT 0,
    PRIMARY KEY (source)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE app_error (
    timestamp    BIGINT       NOT NULL,       -- epoch_ms UTC (fim da janela)
    error_code   VARCHAR(128) NOT NULL,
    manufacturer VARCHAR(64)  NOT NULL,
    errors       BIGINT       NOT NULL,
    devices      BIGINT,
    PRIMARY KEY (timestamp, error_code, manufacturer),
    KEY ix_ae_code (error_code, timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
  PARTITION BY RANGE (timestamp) (PARTITION p_init VALUES LESS THAN (0));

CREATE TABLE app_error_model (
    day_ts       BIGINT       NOT NULL,       -- epoch_ms da meia-noite UTC do dia
    error_code   VARCHAR(128) NOT NULL,
    manufacturer VARCHAR(64)  NOT NULL,
    model        VARCHAR(128) NOT NULL,
    errors       BIGINT       NOT NULL,
    devices      BIGINT,
    PRIMARY KEY (day_ts, error_code, manufacturer, model),
    KEY ix_aem_code (error_code, day_ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
  PARTITION BY RANGE (day_ts) (PARTITION p_init VALUES LESS THAN (0));

CREATE TABLE app_error_version (
    day_ts      BIGINT       NOT NULL,
    error_code  VARCHAR(128) NOT NULL,
    app_version VARCHAR(64)  NOT NULL,
    errors      BIGINT       NOT NULL,
    devices     BIGINT,
    PRIMARY KEY (day_ts, error_code, app_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
  PARTITION BY RANGE (day_ts) (PARTITION p_init VALUES LESS THAN (0));

CREATE TABLE cdn_vod_shadow (
    ts      BIGINT       NOT NULL,       -- epoch_ms UTC
    entity  VARCHAR(128) NOT NULL,       -- PoP
    req_2xx DOUBLE       NOT NULL,
    err_4xx DOUBLE       NOT NULL,
    err_5xx DOUBLE       NOT NULL,
    PRIMARY KEY (ts, entity),
    KEY ix_vodshadow_ent (entity, ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
  PARTITION BY RANGE (ts) (PARTITION p_init VALUES LESS THAN (0));

CREATE TABLE incidents (
    opened_at         BIGINT       NOT NULL,          -- epoch_ms UTC (converte TEXT→ms)
    sys_id            VARCHAR(64)  NOT NULL,
    number            VARCHAR(32),
    resolved_at       BIGINT,
    closed_at         BIGINT,
    priority          VARCHAR(8),
    priority_value    VARCHAR(8),
    state             VARCHAR(32),
    assignment_group  VARCHAR(255),
    business_service  VARCHAR(255),
    cmdb_ci           VARCHAR(255),
    short_description VARCHAR(1024),
    u_this_incident_caused_external_impacts        VARCHAR(8),   -- 'true'/'false'/NULL
    u_this_incident_was_caused_by_a_change_or_deploy VARCHAR(8),
    parent_incident   VARCHAR(32),
    child_incidents   TEXT,
    -- Campos de causa/triagem (04/07/2026; grant snow→SA chegou 30/06).
    -- impact_component* = alias local de u_what_type_of_component_or_service_
    -- generated_the_impact_of_this_incident(+_value) — o nome original tem 75+
    -- chars e estoura o limite de 64 do MySQL (alias no SELECT do coletor).
    state_value       VARCHAR(8),
    category          VARCHAR(255),
    subcategory       VARCHAR(255),
    cause             TEXT,
    caused_by         VARCHAR(255),
    u_what_s_the_root_cause TEXT,
    impact_component  VARCHAR(255),
    impact_component_value VARCHAR(128),
    close_code        VARCHAR(255),
    close_code_value  VARCHAR(128),
    close_notes       TEXT,
    scr_vendor        VARCHAR(255),
    scr_vendor_point_of_contact VARCHAR(255),   -- pode conter nome de pessoa: NÃO expor em artefato/dashboard
    scr_vendor_ticket VARCHAR(255),
    PRIMARY KEY (opened_at, sys_id),                  -- ts primeiro pra partition
    -- sys_id não pode ser UNIQUE sozinho numa tabela particionada (a unique
    -- precisa conter a coluna de partição); a PK (opened_at, sys_id) já garante
    -- unicidade por incidente (opened_at é imutável). Aqui só índice de lookup.
    KEY ix_incidents_sys (sys_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
  PARTITION BY RANGE (opened_at) (PARTITION p_init VALUES LESS THAN (0));

CREATE TABLE player_hourly (
    hour_ts       BIGINT      NOT NULL,                    -- epoch_ms (converte de TEXT ISO)
    player   VARCHAR(64) NOT NULL,
    sessions BIGINT      NOT NULL,
    errors   BIGINT      NOT NULL,
    PRIMARY KEY (hour_ts, player)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
  PARTITION BY RANGE (hour_ts) (PARTITION p_init VALUES LESS THAN (0));

CREATE TABLE device_hourly (
    hour_ts       BIGINT       NOT NULL,
    device   VARCHAR(255) NOT NULL,                   -- 'vendor|model'
    sessions BIGINT       NOT NULL,
    errors   BIGINT       NOT NULL,
    PRIMARY KEY (hour_ts, device)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
  PARTITION BY RANGE (hour_ts) (PARTITION p_init VALUES LESS THAN (0));

CREATE TABLE geo_hourly (
    hour_ts             BIGINT       NOT NULL,
    state_province VARCHAR(8)   NOT NULL,             -- "SP","RJ","?" pra nulo
    isp            VARCHAR(128) NOT NULL,
    sessions       BIGINT       NOT NULL,
    errors         BIGINT       NOT NULL,
    PRIMARY KEY (hour_ts, state_province, isp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
  PARTITION BY RANGE (hour_ts) (PARTITION p_init VALUES LESS THAN (0));

CREATE TABLE live_qoe_hourly (
    hour_ts                 BIGINT      NOT NULL,
    sinal              VARCHAR(64) NOT NULL,          -- extraparam11
    sessions           BIGINT      NOT NULL,
    errors             BIGINT      NOT NULL,
    startup_errors     BIGINT      NOT NULL,
    latency_ms_avg     DOUBLE,
    latency_ms_p50     DOUBLE,
    latency_ms_p95     DOUBLE,
    bufferratio_avg    DOUBLE,
    jointime_s_avg     DOUBLE,
    dropped_frames_avg DOUBLE,
    stalls_avg         DOUBLE,
    bitrate_mbps_avg   DOUBLE,                        -- presente no dump custodiado
    bitrate_mbps_p50   DOUBLE,                        -- presente no dump custodiado
    PRIMARY KEY (hour_ts, sinal)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
  PARTITION BY RANGE (hour_ts) (PARTITION p_init VALUES LESS THAN (0));

CREATE TABLE live_error_attr_hourly (
    hour_ts    BIGINT       NOT NULL,                  -- epoch_ms UTC
    sinal      VARCHAR(64)  NOT NULL,                  -- extraparam11 (slug do canal)
    cdn        VARCHAR(64)  NOT NULL,
    tier       VARCHAR(32)  NOT NULL,                  -- playback_api|edge_isp|core|other
    http_code  VARCHAR(8)   NOT NULL,
    error_name VARCHAR(255) NOT NULL,
    errors     BIGINT       NOT NULL,
    PRIMARY KEY (hour_ts, sinal, cdn, tier, http_code, error_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
  PARTITION BY RANGE (hour_ts) (PARTITION p_init VALUES LESS THAN (0));

CREATE TABLE live_event (
    tid           INT          NOT NULL,     -- transmission_id da grade EPG
    start_ts      BIGINT       NOT NULL,     -- epoch_ms UTC (kickoff do slot)
    end_ts        BIGINT       NOT NULL,
    event_key     VARCHAR(160) NOT NULL,     -- <dia BRT>:<times normalizados>
    event_date    VARCHAR(10)  NOT NULL,     -- dia de PROGRAMAÇÃO em BRT
    slug          VARCHAR(64),               -- slug NPAW do canal (epg_map)
    channel       VARCHAR(96),
    competition   VARCHAR(160),
    program       VARCHAR(255),
    sport         VARCHAR(64),
    team_home     VARCHAR(96),
    team_away     VARCHAR(96),
    sde_id        VARCHAR(32),               -- id do jogo no SDE (dados esportivos)
    guia_slot_id  BIGINT,
    url_program   VARCHAR(255),
    first_seen_ts BIGINT       NOT NULL,     -- 1ª vez que vimos o slot NOMEADO
    updated_at    BIGINT       NOT NULL,
    PRIMARY KEY (tid, start_ts),
    KEY ix_live_event_key  (event_key),
    KEY ix_live_event_date (event_date),
    KEY ix_live_event_sde  (sde_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE live_event_sde (
    sde_id          VARCHAR(32)  NOT NULL,  -- id do jogo no SDE (sem prefixo)
    team_home       VARCHAR(96),            -- canônico do supergraph
    team_away       VARCHAR(96),
    competition     VARCHAR(160),
    kickoff_ts      BIGINT,                 -- epoch_ms UTC do JOGO (não do slot)
    status          VARCHAR(32),
    is_finished     TINYINT      NOT NULL DEFAULT 0,
    tids_jarvis     TEXT         NOT NULL,  -- JSON: transmissionIds associados
    tids_epg        TEXT         NOT NULL,  -- JSON: tids vistos na live_event
    tid_only_epg    TEXT         NOT NULL,  -- JSON: diferença EPG − Jarvis
    tid_only_jarvis TEXT         NOT NULL,  -- JSON: diferença Jarvis − EPG
    name_mismatch   TINYINT      NOT NULL DEFAULT 0,
    epg_teams       TEXT,                   -- o que a live_event tinha (auditoria)
    updated_at      BIGINT       NOT NULL,
    PRIMARY KEY (sde_id),
    KEY ix_les_kickoff  (kickoff_ts),
    KEY ix_les_mismatch (name_mismatch)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE live_active_15min (
    bucket_ts                 BIGINT      NOT NULL,          -- epoch_ms alinhado a 15min
    sinal              VARCHAR(64) NOT NULL,
    active_sessions    BIGINT      NOT NULL,
    active_with_error  BIGINT      NOT NULL,
    joins_in_bucket    BIGINT      NOT NULL,
    latency_ms_p50     DOUBLE,
    latency_ms_p95     DOUBLE,
    bufferratio_avg    DOUBLE,
    jointime_s_avg     DOUBLE,
    dropped_frames_avg DOUBLE,
    PRIMARY KEY (bucket_ts, sinal)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
  PARTITION BY RANGE (bucket_ts) (PARTITION p_init VALUES LESS THAN (0));

CREATE TABLE error_cat_hourly (
    hour_ts        BIGINT                  NOT NULL,
    kind      ENUM('live','vod')      NOT NULL,
    category  VARCHAR(32)             NOT NULL,       -- entrega|acesso|player|origem|outros
    errors    BIGINT                  NOT NULL,
    top_names TEXT,                                   -- [{"name","errors"}, ...] JSON-como-texto
    errors_bot INT                     NOT NULL DEFAULT 0,  -- parcela de `errors` de trafego automatizado (bot/crawler)
    PRIMARY KEY (hour_ts, kind, category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
  PARTITION BY RANGE (hour_ts) (PARTITION p_init VALUES LESS THAN (0));

CREATE TABLE collector_run (
    run_id          BIGINT      NOT NULL AUTO_INCREMENT,
    source          VARCHAR(64) NOT NULL,             -- 'apollo'|'newrelic'|'prometheus'|...
    started_at      BIGINT      NOT NULL,             -- epoch_ms
    finished_at     BIGINT,
    range_start     BIGINT,                           -- janela coletada (epoch_ms)
    range_end       BIGINT,
    rows_upserted   BIGINT      DEFAULT 0,
    bytes_scanned   BIGINT      DEFAULT 0,
    cost_usd        DOUBLE      DEFAULT 0,
    duration_s      DOUBLE,
    notes           TEXT,
    PRIMARY KEY (run_id),
    KEY ix_run_source_started (source, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE apollo_run (
    run_id         BIGINT AUTO_INCREMENT PRIMARY KEY,
    started_at     VARCHAR(40) NOT NULL,
    finished_at    VARCHAR(40),
    kind           VARCHAR(32) NOT NULL,
    range_start    VARCHAR(40),
    range_end      VARCHAR(40),
    pages          BIGINT DEFAULT 0,
    rows_inserted  BIGINT DEFAULT 0,
    rows_updated   BIGINT DEFAULT 0,
    duration_s     DOUBLE,
    notes          TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE nr_run (
    run_id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    started_at      VARCHAR(40) NOT NULL,
    finished_at     VARCHAR(40),
    kind            VARCHAR(32) NOT NULL,
    account_id      BIGINT,
    nrql            TEXT,
    rows_seen       BIGINT DEFAULT 0,
    rows_inserted   BIGINT DEFAULT 0,
    duration_s      DOUBLE,
    notes           TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE prom_run (
    run_id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    started_at      VARCHAR(40) NOT NULL,
    finished_at     VARCHAR(40),
    range_start_ms  BIGINT,
    range_end_ms    BIGINT,
    step_s          BIGINT,
    queries_total   BIGINT,
    queries_ok      BIGINT DEFAULT 0,
    queries_err     BIGINT DEFAULT 0,
    series_touched  BIGINT DEFAULT 0,
    points_inserted BIGINT DEFAULT 0,
    duration_s      DOUBLE,
    notes           TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE rpaas_run (
    run_id        BIGINT AUTO_INCREMENT PRIMARY KEY,
    started_at    VARCHAR(40) NOT NULL,
    finished_at   VARCHAR(40),
    range_start   VARCHAR(40),
    range_end     VARCHAR(40),
    regions       TEXT,
    entries_read  BIGINT DEFAULT 0,
    buckets_upd   BIGINT DEFAULT 0,
    duration_s    DOUBLE,
    notes         TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE ca_run (
    run_id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    started_at      VARCHAR(40) NOT NULL,
    finished_at     VARCHAR(40),
    range_start_ms  BIGINT,
    range_end_ms    BIGINT,
    points_inserted BIGINT DEFAULT 0,
    duration_s      DOUBLE,
    notes           TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE finding_status_log (
    finding_id  VARCHAR(120) NOT NULL,   -- id estável do achado
    ts          BIGINT       NOT NULL,   -- epoch ms UTC da varredura que virou
    from_status VARCHAR(16)  NULL,       -- NULL = 1ª aparição (detecção)
    to_status   VARCHAR(16)  NOT NULL,
    volume      BIGINT       NULL,       -- impacto na janela quente no momento da virada
    unit        VARCHAR(16)  NULL,       -- users | sessions | occurrences | requests
    PRIMARY KEY (finding_id, ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
