-- Sanitized, minimal schema for notebooks 00 and 01 only. All timestamps are UTC epoch ms in 2026.
CREATE TABLE signal_bucket (
    bts BIGINT NOT NULL,
    source VARCHAR(64) NOT NULL,
    entity VARCHAR(128) NOT NULL,
    metric VARCHAR(128) NOT NULL,
    value DOUBLE NULL
);
INSERT INTO signal_bucket (bts, source, entity, metric, value) VALUES
    (1767225600000, 'fixture_collector', 'fixture-service', 'error_rate_pct', 0),
    (1767227400000, 'fixture_collector', 'fixture-service', 'error_rate_pct', 2.5);

CREATE TABLE signal_meta (
    metric VARCHAR(128) NOT NULL,
    description VARCHAR(255) NULL
);
INSERT INTO signal_meta (metric, description) VALUES
    ('error_rate_pct', NULL);

CREATE TABLE nr_run (
    started_at DATETIME NOT NULL,
    finished_at DATETIME NULL,
    metrics_written INT NOT NULL
);
INSERT INTO nr_run (started_at, finished_at, metrics_written) VALUES
    ('2026-01-01 00:00:00', '2026-01-01 00:01:00', 2),
    ('2026-01-01 01:00:00', NULL, 0);

CREATE TABLE player_hourly (hour_ts BIGINT NOT NULL);
INSERT INTO player_hourly (hour_ts) VALUES (1767225600000);

CREATE TABLE incidents (opened_at BIGINT NOT NULL);
INSERT INTO incidents (opened_at) VALUES (1767225600000);

CREATE TABLE incident_label (ts_start BIGINT NOT NULL);
INSERT INTO incident_label (ts_start) VALUES (1767225600000);

CREATE TABLE tsuru_event (start_time_ms BIGINT NOT NULL);
INSERT INTO tsuru_event (start_time_ms) VALUES (1767225600000);

CREATE TABLE live_event (start_ts BIGINT NOT NULL);
INSERT INTO live_event (start_ts) VALUES (1767225600000);

CREATE TABLE live_active_15min (bucket_ts BIGINT NOT NULL);
INSERT INTO live_active_15min (bucket_ts) VALUES (1767225600000);
