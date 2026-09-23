#!/usr/bin/env python3
"""Treina e exporta o bundle versionado usado pelo Analysis Worker.

QoE CSV: hour_ts/sinal/bufferratio_avg/sessions/errors/startup_errors.
Detector CSV (formato longo): timestamp/scope_id/metric/value.
"""
from __future__ import annotations
import argparse, hashlib, json, math
from pathlib import Path
import numpy as np
import pandas as pd
from sklearn.covariance import LedoitWolf
from sklearn.ensemble import RandomForestRegressor
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import brier_score_loss, mean_absolute_error, mean_squared_error

FEATURES = ["bufferratio_avg", "lag_1h", "lag_2h", "lag_3h", "roll_mean_3h", "sessions", "errors", "startup_errors", "hora_sin", "hora_cos", "dia_semana"]

def utc(values: pd.Series) -> pd.Series:
    numeric = pd.to_numeric(values, errors="coerce")
    if numeric.notna().mean() > .95:
        unit = "ms" if numeric.dropna().abs().median() > 10**11 else "s"
        return pd.to_datetime(numeric, unit=unit, utc=True, errors="coerce")
    return pd.to_datetime(values, utc=True, errors="coerce")

def feature_frame(path: Path) -> pd.DataFrame:
    data = pd.read_csv(path)
    required = {"hour_ts", "sinal", "bufferratio_avg", "sessions", "errors", "startup_errors"}
    if not required.issubset(data.columns): raise ValueError(f"QoE CSV sem colunas: {sorted(required-set(data.columns))}")
    data["time"] = utc(data["hour_ts"]); data = data.dropna(subset=["time"]).sort_values(["sinal", "time"])
    for col in ["bufferratio_avg", "sessions", "errors", "startup_errors"]: data[col] = pd.to_numeric(data[col], errors="coerce")
    by = data.groupby("sinal", group_keys=False)
    for lag in (1, 2, 3): data[f"lag_{lag}h"] = by["bufferratio_avg"].shift(lag)
    data["roll_mean_3h"] = by["bufferratio_avg"].transform(lambda s: s.shift(1).rolling(3, min_periods=3).mean())
    data["target"] = by["bufferratio_avg"].shift(-1); data["target_time"] = by["time"].shift(-1)
    data["hora_sin"] = np.sin(2*np.pi*data.time.dt.hour/24); data["hora_cos"] = np.cos(2*np.pi*data.time.dt.hour/24)
    data["dia_semana"] = data.time.dt.dayofweek
    contiguous = (data.target_time-data.time == pd.Timedelta(hours=1))
    for lag in (1, 2, 3): contiguous &= by["time"].shift(lag).rsub(data.time).eq(pd.Timedelta(hours=lag))
    return data.loc[contiguous].dropna(subset=FEATURES+["target", "target_time"]).copy()

def tree_payload(tree) -> dict:
    return {"left": tree.children_left.astype(int).tolist(), "right": tree.children_right.astype(int).tolist(),
            "feature": tree.feature.astype(int).tolist(), "threshold": tree.threshold.tolist(), "value": tree.value[:,0,0].tolist()}

def detector_payload(path: Path, cutoff: pd.Timestamp) -> dict:
    data = pd.read_csv(path)
    required = {"timestamp", "scope_id", "metric", "value"}
    if not required.issubset(data.columns): raise ValueError(f"Detector CSV sem colunas: {sorted(required-set(data.columns))}")
    data["timestamp"] = utc(data.timestamp); data["value"] = pd.to_numeric(data.value, errors="coerce")
    data = data.dropna(subset=["timestamp", "value"]); data = data[data.timestamp < cutoff]
    scopes = {}
    for scope, group in data.groupby("scope_id"):
        matrix = group.pivot_table(index="timestamp", columns="metric", values="value", aggfunc="mean").dropna(axis=1, how="any").dropna()
        if matrix.shape[0] < 96 or matrix.shape[1] < 2: raise ValueError(f"{scope}: detector exige >=96 vetores completos e >=2 métricas")
        fit = LedoitWolf().fit(matrix.to_numpy(float)); centered = matrix.to_numpy(float)-fit.location_
        scores = np.sqrt(np.maximum(0, np.einsum("ij,jk,ik->i", centered, fit.precision_, centered)))
        scopes[str(scope)] = {"metrics": list(map(str, matrix.columns)), "mean": fit.location_.tolist(), "precision": fit.precision_.tolist(), "threshold": float(np.quantile(scores, .99))}
    if not scopes: raise ValueError("Detector CSV não produziu escopos treináveis")
    return scopes

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--qoe-csv", type=Path, required=True); parser.add_argument("--detector-csv", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True); parser.add_argument("--dataset-version", required=True); parser.add_argument("--version", required=True)
    parser.add_argument("--value-threshold", type=float); args = parser.parse_args()
    frame = feature_frame(args.qoe_csv); moments = np.array(sorted(frame.target_time.unique()))
    if len(moments) < 30: raise ValueError("São necessários pelo menos 30 instantes-alvo para corte temporal")
    train_end, calibration_end = pd.Timestamp(moments[int(len(moments)*.6)-1]), pd.Timestamp(moments[int(len(moments)*.8)-1])
    train = frame[frame.target_time <= train_end]; calibration = frame[(frame.target_time > train_end)&(frame.target_time <= calibration_end)]; test = frame[frame.target_time > calibration_end]
    if min(len(train), len(calibration), len(test)) < 10: raise ValueError("Cortes temporais possuem poucas observações")
    threshold = float(args.value_threshold if args.value_threshold is not None else train.target.quantile(.9))
    model = RandomForestRegressor(n_estimators=300, max_depth=8, min_samples_leaf=20, random_state=42, n_jobs=-1).fit(train[FEATURES], train.target)
    cal_prediction = model.predict(calibration[FEATURES]); cal_label = (calibration.target > threshold).astype(int)
    if cal_label.nunique() != 2: raise ValueError("Calibração precisa conter exemplos normais e críticos")
    iso = IsotonicRegression(out_of_bounds="clip").fit(cal_prediction, cal_label)
    if len(iso.X_thresholds_) < 2: raise ValueError("Calibração isotônica degenerada")
    test_prediction = model.predict(test[FEATURES]); test_risk = iso.predict(test_prediction); test_label = (test.target > threshold).astype(int)
    bundle = {"schemaVersion":"analysis-models-v1", "name":"qoe-random-forest", "version":args.version, "approved":False,
      "trainedThrough":calibration.target_time.max().isoformat().replace("+00:00","Z"), "datasetVersion":args.dataset_version, "features":FEATURES,
      "forecast":{"trees":[tree_payload(t.tree_) for t in model.estimators_], "calibration":{"x":iso.X_thresholds_.tolist(),"y":iso.y_thresholds_.tolist()},
        "valueThreshold":threshold,"riskThreshold":.5,"highRiskThreshold":.8},
      "detection":{"robustThreshold":3.5,"minHistoryDays":3,"minHistoryPoints":96,"scopes":detector_payload(args.detector_csv, train_end)},
      "audit":{"split":{"trainThrough":train_end.isoformat(),"calibrationThrough":calibration_end.isoformat(),"testFrom":test.target_time.min().isoformat()},
        "counts":{"train":len(train),"calibration":len(calibration),"test":len(test)},
        "test":{"mae":float(mean_absolute_error(test.target,test_prediction)),"rmse":float(math.sqrt(mean_squared_error(test.target,test_prediction))),
          "baselineMae":float(mean_absolute_error(test.target,test.lag_1h)),"brier":float(brier_score_loss(test_label,test_risk))},
        "sourceHashes":{"qoe":hashlib.sha256(args.qoe_csv.read_bytes()).hexdigest(),"detector":hashlib.sha256(args.detector_csv.read_bytes()).hexdigest()}}}
    args.output.parent.mkdir(parents=True, exist_ok=True); args.output.write_text(json.dumps(bundle, separators=(",",":")), encoding="utf-8")
    print(json.dumps({"output":str(args.output),"approved":False,"audit":bundle["audit"]}, indent=2))
if __name__ == "__main__": main()
