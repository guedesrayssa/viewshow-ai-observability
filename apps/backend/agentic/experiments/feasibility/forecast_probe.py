"""Sondagem exploratória de erros futuros; não altera o modelo operacional."""
import argparse
import json
from pathlib import Path
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import average_precision_score, precision_score, recall_score, brier_score_loss

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--qoe', type=Path, required=True)
p.add_argument('--output', type=Path, required=True)
args = p.parse_args()
d = pd.read_csv(args.qoe)
d['time'] = pd.to_datetime(d.hour_ts, unit='ms', utc=True)
cut = pd.Timestamp('2026-08-20', tz='UTC')
testcut = pd.Timestamp('2026-08-26', tz='UTC')
a = d[d.time < cut].groupby('sinal').agg(n=('sessions', 'size'), traffic=('sessions', 'median'))
eligible = a[(a.n >= 336) & (a.traffic > 10) & (a.index != '?')].index
d = d[d.sinal.isin(eligible)].sort_values(['sinal', 'time']).copy()
d['error_rate'] = d.errors / d.sessions.where(d.sessions > 0)
d['startup_rate'] = d.startup_errors / d.sessions.where(d.sessions > 0)
threshold = d[d.time < cut].groupby('sinal').error_rate.quantile(.95).clip(lower=.05)
d['threshold'] = d.sinal.map(threshold)
g = d.groupby('sinal')
features = ['error_rate', 'startup_rate', 'sessions', 'bufferratio_avg', 'jointime_s_avg']
for c in ['error_rate', 'startup_rate', 'sessions']:
    for lag in [1, 2, 3]:
        k = c + '_lag' + str(lag)
        d[k] = g[c].shift(lag)
        features.append(k)
d['hour'] = d.time.dt.tz_convert('America/Sao_Paulo').dt.hour
d['weekday'] = d.time.dt.tz_convert('America/Sao_Paulo').dt.dayofweek
features += ['hour', 'weekday']
valid = pd.Series(True, index=d.index)
for lag in [1, 2, 3]:
    valid &= (d.time - g.time.shift(lag) == pd.Timedelta(hours=lag))

def metrics(labels, decisions, score):
    return {'samples': len(labels), 'positives': int(labels.sum()),
            'alerts': int(np.sum(decisions)),
            'precision': float(precision_score(labels, decisions, zero_division=0)),
            'recall': float(recall_score(labels, decisions, zero_division=0)),
            'averagePrecision': float(average_precision_score(labels, score))}

results = []
for horizon in [1, 3]:
    x = d.copy()
    x['future_rate'] = g.error_rate.shift(-horizon)
    x['target_time'] = g.time.shift(-horizon)
    x['future_sessions'] = g.sessions.shift(-horizon)
    x = x[valid & (x.target_time-x.time == pd.Timedelta(hours=horizon))].dropna(subset=features+['future_rate'])
    x = x[x.sessions >= 100]
    x['label'] = (x.future_rate > x.threshold) & (x.future_sessions >= 100)
    train = x[x.target_time < cut]
    test = x[(x.time >= testcut) & (x.target_time < pd.Timestamp('2026-09-01', tz='UTC'))]
    model = RandomForestClassifier(n_estimators=100, max_depth=8, min_samples_leaf=30,
                                   random_state=42, n_jobs=-1).fit(train[features], train.label)
    prob = model.predict_proba(test[features])[:, 1]
    decisions = prob > .5
    normal = (test.error_rate <= test.threshold).to_numpy()
    results.append({'horizonBucketOffset': horizon, 'leadToTargetStartHours': horizon-1,
                    'train': len(train), 'test': len(test), 'channels': test.sinal.nunique(),
                    'prevalence': float(test.label.mean()),
                    'forest': {**metrics(test.label, decisions, prob),
                               'brier': float(brier_score_loss(test.label, prob))},
                    'persistence': metrics(test.label, test.error_rate > test.threshold, test.error_rate/test.threshold),
                    'onsetWhileCurrentlyNormal': metrics(test.label[normal], decisions[normal], prob[normal]),
                    'constantTrainPrevalenceBrier': float(brier_score_loss(test.label, np.full(len(test), train.label.mean())))})
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(results, indent=2)+'\n')
print(json.dumps(results, indent=2))
