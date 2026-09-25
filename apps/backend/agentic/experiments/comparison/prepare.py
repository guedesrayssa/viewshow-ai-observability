"""Reserve unseen UTC dates reproducibly; do not expose model outputs during selection."""
import argparse
import json
import random
import sqlite3
import statistics
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from runner import HERE, digest, save, instant

HOUR = 3600000
UNITS = {'bufferratio_avg': 'source ratio; scale unverified', 'sessions': 'sessions/hour',
         'errors': 'events/hour', 'startup_errors': 'events/hour', 'latency_ms_avg': 'ms',
         'jointime_s_avg': 'seconds', 'stalls_avg': 'stalls/session',
         'errors_per_session': 'events/session; not probability'}


def iso(ts):
    return datetime.fromtimestamp(ts / 1000, timezone.utc).isoformat().replace('+00:00', 'Z')


def reserved(block, old):
    start, end = block * 6 * HOUR, (block + 1) * 6 * HOUR
    day = start // (24 * HOUR)
    for case in old:
        a = int(instant(case['reference_window']['start']).timestamp() * 1000)
        b = int(instant(case['cutoff']).timestamp() * 1000)
        if a // (24 * HOUR) == day or (start < b + 6 * HOUR and end > a - 6 * HOUR):
            return True
    return False


def make_case(index, chosen, groups):
    channel, block, peer, category = chosen
    start = block * 6 * HOUR
    records = []
    for name in (channel, peer):
        for row in groups[(name, block)]:
            for metric, unit in UNITS.items():
                value = row.get(metric)
                if metric == 'errors_per_session':
                    value = row['errors'] / row['sessions'] if row['sessions'] and row['errors'] is not None else None
                key = dict(table='live_qoe_hourly', hour_ts=row['hour_ts'], sinal=name, metric=metric)
                records.append(dict(id='obs:' + digest(key)[:16], timestamp=iso(row['hour_ts']),
                                    available_at=iso(row['hour_ts'] + HOUR), metric=metric,
                                    scope='sinal:' + name, value=value, unit=unit,
                                    source='live_qoe_hourly', source_key=key))
    values = [r['bufferratio_avg'] for r in groups[(channel, block)]]
    before, after = statistics.mean(values[:3]), statistics.mean(values[3:])
    return dict(id=f'heldout-{index:02}', synthetic=False, cutoff=iso(start + 6 * HOUR),
                signal=dict(metric='bufferratio_avg', scope='sinal:' + channel,
                            trigger='EXPLORATORY_WINDOW_COMPARISON',
                            method='Descriptive mean comparison, not a trained detector or forecast',
                            reference_mean=before, current_mean=after, delta=after-before,
                            unit=UNITS['bufferratio_avg']),
                reference_window=dict(start=iso(start), end=iso(start+3*HOUR), expected_points=3),
                current_window=dict(start=iso(start+3*HOUR), end=iso(start+6*HOUR), expected_points=3),
                records=records)


def build(source, prior, output):
    if output.exists():
        raise ValueError('Refusing to replace a reserved dataset')
    old = json.loads(prior.read_text())
    policy = json.loads((HERE / 'protocol.json').read_text())
    extraction = json.loads(source.with_suffix('.manifest.json').read_text())
    if old['source_sha256'] != extraction['source_sha256']:
        raise ValueError('Source dump differs from the recorded extraction')
    db = sqlite3.connect(f'file:{source}?mode=ro', uri=True); db.row_factory = sqlite3.Row
    groups = defaultdict(list)
    for row in db.execute('SELECT * FROM qoe ORDER BY hour_ts,sinal'):
        block = row['hour_ts'] // (6 * HOUR)
        if not reserved(block, old['cases']):
            groups[(row['sinal'], block)].append(dict(row))
    db.close()
    complete = {}
    for key, rows in groups.items():
        block = key[1]
        if len(rows) != 6 or [r['hour_ts'] for r in rows] != [block*6*HOUR+i*HOUR for i in range(6)]:
            continue
        if any(r['bufferratio_avg'] is None or r['sessions'] is None or r['sessions'] < 20 for r in rows):
            continue
        if statistics.median(r['sessions'] for r in rows) >= 100:
            complete[key] = rows
    candidates = defaultdict(list)
    for (channel, block), rows in complete.items():
        before = statistics.mean(r['bufferratio_avg'] for r in rows[:3])
        after = statistics.mean(r['bufferratio_avg'] for r in rows[3:])
        delta, rel = after-before, (after-before)/max(abs(before), .1)
        category = ('increase' if rel >= 1 and delta > .5 else 'decrease' if rel <= -.5 and delta < -.5
                    else 'stable' if abs(rel) <= .1 and abs(delta) < .2 else None)
        peers = [(statistics.median(r['sessions'] for r in rr), cc) for (cc, bb), rr in complete.items() if bb == block and cc != channel]
        if category and peers:
            candidates[category].append((channel, block, max(peers)[1], category))
    rng = random.Random(policy['selection_seed'])
    for values in candidates.values():
        values.sort(); rng.shuffle(values)
    chosen, days = [], set()
    categories = [c for c, amount in policy['strata'].items() for _ in range(amount)]
    # Balanced greedy allocation; fail instead of silently weakening the reservation rule.
    for category in categories:
        item = next((c for c in candidates[category] if c[1] // 4 not in days), None)
        if item is None:
            raise ValueError('Insufficient eligible dates for ' + category)
        chosen.append(item); days.add(item[1] // 4)
    cases = [make_case(i, c, complete) for i, c in enumerate(chosen, 1)]
    old_ids = {r['id'] for c in old['cases'] for r in c['records']}
    if any(r['id'] in old_ids for c in cases for r in c['records']):
        raise ValueError('Overlap with development records')
    dataset = dict(kind='real-qoe-reserved-no-causal-labels', purpose='evaluation',
                   source_sha256=extraction['source_sha256'], cases=cases)
    output.mkdir(parents=True)
    save(output / 'evaluation.json', dataset)
    calibration = [c for c in old['cases'] if c['id'] in ('real-03', 'real-05', 'real-09')]
    save(output / 'calibration.json', dict(kind='previously-inspected-real-development', purpose='calibration',
                                         source_sha256=old['source_sha256'], cases=calibration))
    save(output / 'reservation.json', dict(dataset_hash=digest(dataset), old_dataset_hash=digest(old),
        protocol_hash=digest(policy), selection_seed=policy['selection_seed'],
        cases=len(cases), observations=sum(len(c['records']) for c in cases),
        strata=policy['strata'], overlap_records=0, distinct_utc_dates=len(days),
        exclusions='All previously inspected UTC start dates and six-hour guards around their windows.',
        caveats=['Calendar exclusion does not prove distinct operational incidents.',
                 'Contrast-selected aggregate QoE windows without causal labels.',
                 'Missing-data stress tests remain synthetic local tests, not natural real incidents.',
                 'Hour-end availability assumed; arrival and revision times unknown.']))
    print(json.dumps({'reserved_cases': len(cases), 'observations': sum(len(c['records']) for c in cases),
                      'overlap_records': 0, 'distinct_dates': len(days), 'dataset_hash': digest(dataset)}))


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--source', type=Path, required=True)
    p.add_argument('--prior', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args(); build(a.source, a.prior, a.output)
