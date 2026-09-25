#!/usr/bin/env python3
"""Treina e exporta o bundle versionado usado pelo Analysis Worker.

QoE CSV: hour_ts/sinal/bufferratio_avg/sessions/errors/startup_errors.
Detector CSV (formato longo): timestamp/scope_id/metric/value.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.covariance import LedoitWolf
from sklearn.ensemble import RandomForestRegressor
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import (brier_score_loss, confusion_matrix,
                             mean_absolute_error, mean_squared_error,
                             precision_score, recall_score)


FEATURES = ["bufferratio_avg", "lag_1h", "lag_2h", "lag_3h", "roll_mean_3h",
            "sessions", "errors", "startup_errors", "hora_sin", "hora_cos", "dia_semana"]


def utc(values: pd.Series) -> pd.Series:
    numeric = pd.to_numeric(values, errors="coerce")
    if numeric.notna().mean() > .95:
        unit = "ms" if numeric.dropna().abs().median() > 10**11 else "s"
        return pd.to_datetime(numeric, unit=unit, utc=True, errors="coerce")
    return pd.to_datetime(values, utc=True, errors="coerce")


def feature_frame(path: Path, min_channel_rows: int, min_median_sessions: float,
                  excluded_channels: set[str]) -> tuple[pd.DataFrame, dict]:
    data = pd.read_csv(path)
    required = {"hour_ts", "sinal", "bufferratio_avg", "sessions", "errors", "startup_errors"}
    if not required.issubset(data.columns):
        raise ValueError(f"QoE CSV sem colunas: {sorted(required-set(data.columns))}")
    data["time"] = utc(data["hour_ts"])
    data = data.dropna(subset=["time"]).sort_values(["sinal", "time"])
    for column in ["bufferratio_avg", "sessions", "errors", "startup_errors"]:
        data[column] = pd.to_numeric(data[column], errors="coerce")

    coverage = data.groupby("sinal").agg(rows=("time", "size"), medianSessions=("sessions", "median"))
    eligible = coverage[(coverage.rows >= min_channel_rows) &
                        (coverage.medianSessions > min_median_sessions) &
                        (~coverage.index.astype(str).isin(excluded_channels))].index
    selection = {
        "inputChannels": int(len(coverage)), "eligibleChannels": int(len(eligible)),
        "excludedChannels": int(len(coverage)-len(eligible)), "minChannelRows": min_channel_rows,
        "minMedianSessionsExclusive": min_median_sessions, "explicitlyExcluded": sorted(excluded_channels),
    }
    data = data[data.sinal.isin(eligible)].copy()
    if data.empty:
        raise ValueError("Filtro de cobertura/tráfego removeu todos os canais")

    by = data.groupby("sinal", group_keys=False)
    for lag in (1, 2, 3):
        data[f"lag_{lag}h"] = by["bufferratio_avg"].shift(lag)
    data["roll_mean_3h"] = by["bufferratio_avg"].transform(lambda values: values.shift(1).rolling(3, min_periods=3).mean())
    data["target"] = by["bufferratio_avg"].shift(-1)
    data["target_time"] = by["time"].shift(-1)
    data["hora_sin"] = np.sin(2*np.pi*data.time.dt.hour/24)
    data["hora_cos"] = np.cos(2*np.pi*data.time.dt.hour/24)
    data["dia_semana"] = data.time.dt.dayofweek
    contiguous = (data.target_time-data.time == pd.Timedelta(hours=1))
    for lag in (1, 2, 3):
        contiguous &= by["time"].shift(lag).rsub(data.time).eq(pd.Timedelta(hours=lag))
    frame = data.loc[contiguous].dropna(subset=FEATURES+["target", "target_time"]).copy()
    selection["usableRows"] = int(len(frame))
    if frame.empty:
        raise ValueError("Nenhuma sequência horária contígua após os filtros")
    return frame, selection


def tree_payload(tree) -> dict:
    return {"left": tree.children_left.astype(int).tolist(), "right": tree.children_right.astype(int).tolist(),
            "feature": tree.feature.astype(int).tolist(), "threshold": tree.threshold.tolist(),
            "value": tree.value[:, 0, 0].tolist()}


def detector_payload(path: Path, fit_cutoff: pd.Timestamp, calibration_end: pd.Timestamp,
                     min_metric_coverage: float = .8,
                     required_metric: str = "bufferratio_avg") -> tuple[dict, dict]:
    data = pd.read_csv(path)
    required = {"timestamp", "scope_id", "metric", "value"}
    if not required.issubset(data.columns):
        raise ValueError(f"Detector CSV sem colunas: {sorted(required-set(data.columns))}")
    data["timestamp"] = utc(data.timestamp)
    data["value"] = pd.to_numeric(data.value, errors="coerce")
    data = data.dropna(subset=["timestamp", "value"])
    fit_data = data[data.timestamp < fit_cutoff]
    calibration_data = data[(data.timestamp >= fit_cutoff) & (data.timestamp <= calibration_end)]
    scopes, excluded = {}, {}
    threshold_sources: dict[str, int] = {"calibration": 0, "training-fallback": 0}
    for scope, group in fit_data.groupby("scope_id"):
        pivot = group.pivot_table(index="timestamp", columns="metric", values="value", aggfunc="mean")
        coverage = pivot.notna().mean()
        selected = list(coverage[(coverage >= min_metric_coverage) & (pivot.notna().sum() >= 96)].index)
        matrix = pivot[selected].dropna() if selected else pivot.iloc[:, :0]
        if required_metric not in selected:
            excluded[str(scope)] = {"completeVectors": int(matrix.shape[0]), "completeMetrics": int(matrix.shape[1]),
                                    "reason": f"{required_metric}:INSUFFICIENT_COVERAGE"}
            continue
        if matrix.shape[0] < 96 or matrix.shape[1] < 2:
            excluded[str(scope)] = {"completeVectors": int(matrix.shape[0]), "completeMetrics": int(matrix.shape[1]),
                                    "reason": "INSUFFICIENT_COMPLETE_VECTORS"}
            continue
        fit = LedoitWolf().fit(matrix.to_numpy(float))
        centered = matrix.to_numpy(float)-fit.location_
        fit_scores = np.sqrt(np.maximum(0, np.einsum("ij,jk,ik->i", centered, fit.precision_, centered)))
        calibration_group = calibration_data[calibration_data.scope_id == scope]
        calibration_matrix = calibration_group.pivot_table(index="timestamp", columns="metric", values="value", aggfunc="mean")
        if set(selected).issubset(calibration_matrix.columns):
            calibration_matrix = calibration_matrix[selected].dropna()
        else:
            calibration_matrix = calibration_matrix.iloc[:, :0]
        if len(calibration_matrix) >= 96:
            calibration_centered = calibration_matrix.to_numpy(float)-fit.location_
            threshold_scores = np.sqrt(np.maximum(0, np.einsum("ij,jk,ik->i", calibration_centered, fit.precision_, calibration_centered)))
            threshold_source = "calibration"
        else:
            threshold_scores = fit_scores
            threshold_source = "training-fallback"
        threshold_sources[threshold_source] += 1
        scopes[str(scope)] = {"metrics": list(map(str, matrix.columns)), "mean": fit.location_.tolist(),
                              "precision": fit.precision_.tolist(), "threshold": float(np.quantile(threshold_scores, .99))}
    if not scopes:
        raise ValueError("Detector CSV não produziu escopos treináveis")
    return scopes, {"inputScopes": int(fit_data.scope_id.nunique()), "trainedScopes": len(scopes),
                    "excludedScopes": len(excluded), "requiredMetric": required_metric,
                    "minMetricCoverage": min_metric_coverage, "thresholdSources": threshold_sources,
                    "excluded": excluded}


def classification_metrics(labels: pd.Series, risks: np.ndarray, threshold: float) -> dict:
    decisions = (risks > threshold).astype(int)
    tn, fp, fn, tp = confusion_matrix(labels, decisions, labels=[0, 1]).ravel()
    return {"threshold": threshold, "confusion": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
            "precision": float(precision_score(labels, decisions, zero_division=0)),
            "recall": float(recall_score(labels, decisions, zero_division=0)),
            "falsePositiveRate": float(fp/(fp+tn)) if fp+tn else None}


def detector_backtest(path: Path, scopes: dict, test_from: pd.Timestamp) -> dict:
    data = pd.read_csv(path)
    data["timestamp"] = utc(data.timestamp)
    data["value"] = pd.to_numeric(data.value, errors="coerce")
    data = data.dropna(subset=["timestamp", "value"])
    data = data[data.timestamp >= test_from]
    vectors = alerts = 0
    scopes_with_vectors = scopes_with_alerts = 0
    for scope, group in data.groupby("scope_id"):
        trained = scopes.get(str(scope))
        if not trained:
            continue
        matrix = group.pivot_table(index="timestamp", columns="metric", values="value", aggfunc="mean")
        if not set(trained["metrics"]).issubset(matrix.columns):
            continue
        matrix = matrix[trained["metrics"]].dropna()
        if matrix.empty:
            continue
        values = matrix.to_numpy(float)
        centered = values-np.array(trained["mean"])
        precision = np.array(trained["precision"])
        scores = np.sqrt(np.maximum(0, np.einsum("ij,jk,ik->i", centered, precision, centered)))
        scope_alerts = int((scores > trained["threshold"]).sum())
        vectors += len(scores); alerts += scope_alerts; scopes_with_vectors += 1
        scopes_with_alerts += int(scope_alerts > 0)
    return {"testFrom": test_from.isoformat(), "vectors": vectors, "alerts": alerts,
            "alertRate": float(alerts/vectors) if vectors else None, "scopesWithVectors": scopes_with_vectors,
            "scopesWithAlerts": scopes_with_alerts,
            "limitation": "Taxa de alertas sem ground truth; não representa precisão ou recall."}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--qoe-csv", type=Path, required=True)
    parser.add_argument("--detector-csv", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--dataset-version", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--value-threshold", type=float)
    parser.add_argument("--min-channel-rows", type=int, default=168)
    parser.add_argument("--min-median-sessions", type=float, default=10)
    parser.add_argument("--exclude-channel", action="append", default=["?"])
    args = parser.parse_args()
    if args.min_channel_rows < 96 or args.min_median_sessions < 0:
        raise ValueError("Filtros de elegibilidade inválidos")

    frame, forecast_selection = feature_frame(
        args.qoe_csv, args.min_channel_rows, args.min_median_sessions, set(args.exclude_channel))
    moments = np.array(sorted(frame.target_time.unique()))
    if len(moments) < 30:
        raise ValueError("São necessários pelo menos 30 instantes-alvo para corte temporal")
    train_end = pd.Timestamp(moments[int(len(moments)*.6)-1])
    calibration_end = pd.Timestamp(moments[int(len(moments)*.8)-1])
    train = frame[frame.target_time <= train_end]
    calibration = frame[(frame.target_time > train_end) & (frame.target_time <= calibration_end)]
    test = frame[frame.target_time > calibration_end]
    if min(len(train), len(calibration), len(test)) < 10:
        raise ValueError("Cortes temporais possuem poucas observações")
    threshold = float(args.value_threshold if args.value_threshold is not None else train.target.quantile(.9))
    model = RandomForestRegressor(n_estimators=300, max_depth=8, min_samples_leaf=20,
                                  random_state=42, n_jobs=-1).fit(train[FEATURES], train.target)
    calibration_prediction = model.predict(calibration[FEATURES])
    calibration_label = (calibration.target > threshold).astype(int)
    if calibration_label.nunique() != 2:
        raise ValueError("Calibração precisa conter exemplos normais e críticos")
    isotonic = IsotonicRegression(out_of_bounds="clip").fit(calibration_prediction, calibration_label)
    if len(isotonic.X_thresholds_) < 2:
        raise ValueError("Calibração isotônica degenerada")

    test_prediction = model.predict(test[FEATURES])
    test_risk = isotonic.predict(test_prediction)
    test_label = (test.target > threshold).astype(int)
    channel_mae = test.assign(error=np.abs(test.target-test_prediction)).groupby("sinal").error.mean()
    detector_scopes, detector_selection = detector_payload(args.detector_csv, train_end, calibration_end)
    operating_points = [classification_metrics(test_label, test_risk, point) for point in (.2, .3, .4, .5, .6, .7, .8)]
    selected_point = next(point for point in operating_points if point["threshold"] == .5)
    detector_test = detector_backtest(args.detector_csv, detector_scopes, test.target_time.min())
    bundle = {
        "schemaVersion": "analysis-models-v1", "name": "qoe-random-forest", "version": args.version,
        "approved": False, "trainedThrough": calibration.target_time.max().isoformat().replace("+00:00", "Z"),
        "datasetVersion": args.dataset_version, "features": FEATURES,
        "forecast": {"trees": [tree_payload(estimator.tree_) for estimator in model.estimators_],
                     "calibration": {"x": isotonic.X_thresholds_.tolist(), "y": isotonic.y_thresholds_.tolist()},
                     "valueThreshold": threshold, "riskThreshold": .5, "highRiskThreshold": .8},
        "detection": {"robustThreshold": 3.5, "minHistoryDays": 3, "minHistoryPoints": 96,
                      "scopes": detector_scopes},
        "audit": {
            "split": {"trainThrough": train_end.isoformat(), "calibrationThrough": calibration_end.isoformat(),
                      "testFrom": test.target_time.min().isoformat()},
            "selection": {"forecast": forecast_selection, "detector": detector_selection},
            "counts": {"train": len(train), "calibration": len(calibration), "test": len(test)},
            "test": {"mae": float(mean_absolute_error(test.target, test_prediction)),
                     "rmse": float(math.sqrt(mean_squared_error(test.target, test_prediction))),
                     "macroChannelMae": float(channel_mae.mean()),
                     "baselineMae": float(mean_absolute_error(test.target, test.lag_1h)),
                     "brier": float(brier_score_loss(test_label, test_risk)), "riskThreshold": .5,
                     "confusion": selected_point["confusion"], "precision": selected_point["precision"],
                     "recall": selected_point["recall"], "falsePositiveRate": selected_point["falsePositiveRate"],
                     "operatingPoints": operating_points},
            "detectorTest": detector_test,
            "sourceHashes": {"qoe": hashlib.sha256(args.qoe_csv.read_bytes()).hexdigest(),
                             "detector": hashlib.sha256(args.detector_csv.read_bytes()).hexdigest()},
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(bundle, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"output": str(args.output), "approved": False, "audit": bundle["audit"]}, indent=2))


if __name__ == "__main__":
    main()
