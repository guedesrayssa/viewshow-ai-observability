ALTER TABLE app_error ADD PARTITION (PARTITION p_fixture VALUES LESS THAN MAXVALUE);
ALTER TABLE app_error_model ADD PARTITION (PARTITION p_fixture VALUES LESS THAN MAXVALUE);
ALTER TABLE app_error_version ADD PARTITION (PARTITION p_fixture VALUES LESS THAN MAXVALUE);
ALTER TABLE cdn_vod_shadow ADD PARTITION (PARTITION p_fixture VALUES LESS THAN MAXVALUE);
ALTER TABLE incidents ADD PARTITION (PARTITION p_fixture VALUES LESS THAN MAXVALUE);
ALTER TABLE player_hourly ADD PARTITION (PARTITION p_fixture VALUES LESS THAN MAXVALUE);
ALTER TABLE device_hourly ADD PARTITION (PARTITION p_fixture VALUES LESS THAN MAXVALUE);
ALTER TABLE geo_hourly ADD PARTITION (PARTITION p_fixture VALUES LESS THAN MAXVALUE);
ALTER TABLE live_qoe_hourly ADD PARTITION (PARTITION p_fixture VALUES LESS THAN MAXVALUE);
ALTER TABLE live_error_attr_hourly ADD PARTITION (PARTITION p_fixture VALUES LESS THAN MAXVALUE);
ALTER TABLE live_active_15min ADD PARTITION (PARTITION p_fixture VALUES LESS THAN MAXVALUE);
ALTER TABLE error_cat_hourly ADD PARTITION (PARTITION p_fixture VALUES LESS THAN MAXVALUE);

INSERT INTO signal_bucket (bts, source, entity, metric, value) VALUES
    (1787997600000, 'apollo', 'edge-a', 'requests', 10.0),
    (1787998500000, 'apollo', 'edge-a', 'requests', 11.0),
    (1787999400000, 'prometheus', 'edge-b', 'latency', 12.5);

INSERT INTO signal_meta
    (source, last_ingested_ts, last_run_at, rows_total, rows_last_run) VALUES
    ('apollo', 1788001800000, '2026-08-29T11:30:00Z', 2, 1),
    ('source-without-time', NULL, NULL, 1, 1);

INSERT INTO app_error
    (timestamp, error_code, manufacturer, errors, devices) VALUES
    (1788000000000, 'APP-001', 'manufacturer-a', 4, 3);
INSERT INTO app_error_model
    (day_ts, error_code, manufacturer, model, errors, devices) VALUES
    (1787961600000, 'APP-001', 'manufacturer-a', 'model-a', 4, 3);
INSERT INTO app_error_version
    (day_ts, error_code, app_version, errors, devices) VALUES
    (1787961600000, 'APP-001', '1.0.0', 4, 3);
INSERT INTO cdn_vod_shadow (ts, entity, req_2xx, err_4xx, err_5xx) VALUES
    (1788000000000, 'pop-a', 100.0, 2.0, 1.0);

INSERT INTO incidents (
    opened_at, sys_id, number, resolved_at, closed_at, priority, priority_value,
    state, assignment_group, business_service, cmdb_ci, short_description,
    u_this_incident_caused_external_impacts,
    u_this_incident_was_caused_by_a_change_or_deploy,
    parent_incident, child_incidents, state_value, category, subcategory, cause,
    caused_by, u_what_s_the_root_cause, impact_component, impact_component_value,
    close_code, close_code_value, close_notes, scr_vendor,
    scr_vendor_point_of_contact, scr_vendor_ticket
) VALUES (
    1788000000000, 'incident-fixture-001', 'INC-FIXTURE-001', NULL, NULL, '2', '2',
    'open', 'operations', 'streaming', 'component-a', 'Synthetic playback degradation',
    'true', 'false', NULL, '[]', '1', 'delivery', 'cdn', NULL,
    NULL, NULL, 'edge', 'edge', NULL, NULL, NULL, 'vendor-a', NULL, 'TICKET-001'
);

INSERT INTO player_hourly (hour_ts, player, sessions, errors) VALUES
    (1788000000000, 'web', 100, 5);
INSERT INTO device_hourly (hour_ts, device, sessions, errors) VALUES
    (1788000000000, 'vendor-a|model-a', 80, 4);
INSERT INTO geo_hourly (hour_ts, state_province, isp, sessions, errors) VALUES
    (1788000000000, 'SP', 'isp-a', 70, 3);
INSERT INTO live_qoe_hourly (
    hour_ts, sinal, sessions, errors, startup_errors, latency_ms_avg,
    latency_ms_p50, latency_ms_p95, bufferratio_avg, jointime_s_avg,
    dropped_frames_avg, stalls_avg
) VALUES (
    1787997600000, 'channel-a', 60, 3, 1, 100.0, 90.0, 150.0, 0.01, 1.2, 0.5, 0.1
);
INSERT INTO live_error_attr_hourly
    (hour_ts, sinal, cdn, tier, http_code, error_name, errors) VALUES
    (1788000000000, 'channel-a', 'cdn-a', 'edge_isp', '503', 'upstream_error', 3);

INSERT INTO live_event (
    tid, start_ts, end_ts, event_key, event_date, slug, channel, competition,
    program, sport, team_home, team_away, sde_id, guia_slot_id, url_program,
    first_seen_ts, updated_at
) VALUES
    (101, 1788000000000, 1788007200000, '2026-08-29:fixture-a-v-fixture-b',
     '2026-08-29', 'channel-a', 'Channel A', 'Fixture League', 'Fixture Match',
     'football', 'Fixture A', 'Fixture B', 'sde-fixture-001', 1001, NULL,
     1787999000000, 1787999900000),
    (102, 1788009000000, 1788016200000, '2026-08-29:fixture-c-v-fixture-d',
     '2026-08-29', 'channel-b', 'Channel B', NULL, 'Synthetic Program',
     NULL, NULL, NULL, NULL, 1002, NULL, 1788008000000, 1788008900000);

INSERT INTO live_event_sde (
    sde_id, team_home, team_away, competition, kickoff_ts, status, is_finished,
    tids_jarvis, tids_epg, tid_only_epg, tid_only_jarvis, name_mismatch,
    epg_teams, updated_at
) VALUES
    ('sde-fixture-001', 'Fixture A', 'Fixture B', 'Fixture League', 1788000000000,
     'scheduled', 0, '[101]', '[101]', '[]', '[]', 0,
     '["Fixture A","Fixture B"]', 1787999900000),
    ('sde-fixture-002', NULL, NULL, NULL, NULL, NULL, 0,
     '[]', '[]', '[]', '[]', 0, NULL, 1787999900000);

INSERT INTO live_active_15min (
    bucket_ts, sinal, active_sessions, active_with_error, joins_in_bucket,
    latency_ms_p50, latency_ms_p95, bufferratio_avg, jointime_s_avg,
    dropped_frames_avg
) VALUES (
    1787997600000, 'channel-a', 50, 2, 8, 90.0, 150.0, 0.01, 1.2, 0.5
);

INSERT INTO error_cat_hourly
    (hour_ts, kind, category, errors, top_names, errors_bot) VALUES
    (1788001200000, 'live', 'delivery', 10, '[{"name":"synthetic-a","errors":10}]', 0),
    (1788004800000, 'live', 'delivery', 10, '[{"name":"synthetic-b","errors":7}]', 3);

INSERT INTO collector_run (
    run_id, source, started_at, finished_at, range_start, range_end,
    rows_upserted, bytes_scanned, cost_usd, duration_s, notes
) VALUES (
    1, 'apollo', 1788000000000, 1788000060000, 1787996400000, 1788000000000,
    2, 1024, 0.01, 60.0, 'synthetic fixture'
);
INSERT INTO apollo_run (
    run_id, started_at, finished_at, kind, range_start, range_end, pages,
    rows_inserted, rows_updated, duration_s, notes
) VALUES (
    1, '2026-08-29T10:40:00Z', '2026-08-29T10:41:00Z', 'incremental',
    '2026-08-29T09:40:00Z', '2026-08-29T10:40:00Z', 1, 2, 0, 60.0,
    'synthetic fixture'
);
INSERT INTO nr_run (
    run_id, started_at, finished_at, kind, account_id, nrql, rows_seen,
    rows_inserted, duration_s, notes
) VALUES (
    1, '2026-08-29T10:40:00Z', '2026-08-29T10:41:00Z', 'incremental',
    1001, 'SELECT count(*) FROM SyntheticEvent', 1, 1, 60.0, 'synthetic fixture'
);
INSERT INTO prom_run (
    run_id, started_at, finished_at, range_start_ms, range_end_ms, step_s,
    queries_total, queries_ok, queries_err, series_touched, points_inserted,
    duration_s, notes
) VALUES (
    1, '2026-08-29T10:40:00Z', '2026-08-29T10:41:00Z', 1787996400000,
    1788000000000, 60, 1, 1, 0, 1, 1, 60.0, 'synthetic fixture'
);
INSERT INTO rpaas_run (
    run_id, started_at, finished_at, range_start, range_end, regions,
    entries_read, buckets_upd, duration_s, notes
) VALUES (
    1, '2026-08-29T10:40:00Z', '2026-08-29T10:41:00Z',
    '2026-08-29T09:40:00Z', '2026-08-29T10:40:00Z', '["region-a"]',
    1, 1, 60.0, 'synthetic fixture'
);
INSERT INTO ca_run (
    run_id, started_at, finished_at, range_start_ms, range_end_ms,
    points_inserted, duration_s, notes
) VALUES (
    1, '2026-08-29T10:40:00Z', '2026-08-29T10:41:00Z', 1787996400000,
    1788000000000, 1, 60.0, 'synthetic fixture'
);

INSERT INTO finding_status_log
    (finding_id, ts, from_status, to_status, volume, unit) VALUES
    ('finding-fixture-001', 1788000000000, NULL, 'explained', 3, 'sessions');
