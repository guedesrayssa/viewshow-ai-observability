"""Testes das funções puras de domínio: janelas, buckets e estatísticas."""

from __future__ import annotations

import unittest
from datetime import timedelta

from app.domain.statistics import mean, pearson, percentile, ratio
from app.domain.time_window import (
    TimeWindow,
    group_by_bucket,
    parse_duration,
    resolve_interval,
)
from app.errors import ValidationError
from tests.factories import BASE_TIME, at, event


class ParseDurationTests(unittest.TestCase):
    def test_accepts_supported_units(self):
        self.assertEqual(parse_duration("30s", field="window"), timedelta(seconds=30))
        self.assertEqual(parse_duration("15m", field="window"), timedelta(minutes=15))
        self.assertEqual(parse_duration("2h", field="window"), timedelta(hours=2))
        self.assertEqual(parse_duration("7d", field="window"), timedelta(days=7))

    def test_rejects_unknown_format(self):
        for raw in ("15", "15x", "m15", "-5m", ""):
            with self.assertRaises(ValidationError):
                parse_duration(raw, field="window")

    def test_rejects_zero(self):
        with self.assertRaises(ValidationError):
            parse_duration("0m", field="window")


class TimeWindowTests(unittest.TestCase):
    def test_defaults_to_the_configured_window(self):
        result = TimeWindow.from_args({}, default=timedelta(minutes=15), now=BASE_TIME)
        self.assertEqual(result.end, BASE_TIME)
        self.assertEqual(result.duration, timedelta(minutes=15))

    def test_relative_window_ends_now(self):
        result = TimeWindow.from_args(
            {"window": "1h"}, default=timedelta(minutes=15), now=BASE_TIME
        )
        self.assertEqual(result.start, at(minutes=-60))
        self.assertEqual(result.end, BASE_TIME)

    def test_absolute_window(self):
        result = TimeWindow.from_args(
            {"from": "2026-08-11T11:00:00Z", "to": "2026-08-11T12:00:00Z"},
            default=timedelta(minutes=15),
            now=BASE_TIME,
        )
        self.assertEqual(result.duration, timedelta(hours=1))
        self.assertEqual(result.end, BASE_TIME)

    def test_only_from_ends_now(self):
        result = TimeWindow.from_args(
            {"from": "2026-08-11T11:30:00Z"}, default=timedelta(minutes=15), now=BASE_TIME
        )
        self.assertEqual(result.duration, timedelta(minutes=30))

    def test_rejects_mixing_relative_and_absolute(self):
        with self.assertRaises(ValidationError):
            TimeWindow.from_args(
                {"window": "1h", "from": "2026-08-11T11:00:00Z"},
                default=timedelta(minutes=15),
                now=BASE_TIME,
            )

    def test_rejects_inverted_window(self):
        with self.assertRaises(ValidationError):
            TimeWindow.from_args(
                {"from": "2026-08-11T13:00:00Z", "to": "2026-08-11T12:00:00Z"},
                default=timedelta(minutes=15),
                now=BASE_TIME,
            )

    def test_rejects_window_above_maximum(self):
        with self.assertRaises(ValidationError):
            TimeWindow.from_args(
                {"window": "40d"},
                default=timedelta(minutes=15),
                now=BASE_TIME,
                maximum=timedelta(days=30),
            )

    def test_rejects_invalid_timestamp(self):
        with self.assertRaises(ValidationError):
            TimeWindow.from_args({"from": "ontem"}, default=timedelta(minutes=15), now=BASE_TIME)

    def test_buckets_cover_the_window_and_clip_the_last_slice(self):
        buckets = TimeWindow(at(0), at(25)).buckets(timedelta(minutes=10))
        self.assertEqual(len(buckets), 3)
        self.assertEqual(buckets[0].start, at(0))
        self.assertEqual(buckets[-1].end, at(25))
        self.assertEqual(buckets[-1].duration, timedelta(minutes=5))


class ResolveIntervalTests(unittest.TestCase):
    def test_derives_a_round_interval_from_the_window(self):
        self.assertEqual(resolve_interval(TimeWindow(at(0), at(60))), timedelta(minutes=1))
        self.assertEqual(resolve_interval(TimeWindow(at(0), at(60 * 24))), timedelta(minutes=30))

    def test_honours_an_explicit_interval(self):
        interval = resolve_interval(TimeWindow(at(0), at(60)), "5m")
        self.assertEqual(interval, timedelta(minutes=5))

    def test_rejects_intervals_beyond_the_bucket_limit(self):
        with self.assertRaises(ValidationError):
            resolve_interval(TimeWindow(at(0), at(60)), "10s", max_buckets=100)


class GroupByBucketTests(unittest.TestCase):
    def test_distributes_records_across_buckets(self):
        buckets = TimeWindow(at(0), at(30)).buckets(timedelta(minutes=10))
        events = [event(minutes=1), event(minutes=9), event(minutes=12), event(minutes=29)]

        grouped = group_by_bucket(events, buckets)

        self.assertEqual([len(group) for group in grouped], [2, 1, 1])

    def test_boundary_records_belong_to_a_single_bucket(self):
        buckets = TimeWindow(at(0), at(20)).buckets(timedelta(minutes=10))
        grouped = group_by_bucket([event(minutes=10), event(minutes=20)], buckets)

        # O registro na fronteira cai no bucket seguinte; o do fim da janela
        # pertence ao último bucket, cujo limite é inclusivo.
        self.assertEqual([len(group) for group in grouped], [0, 2])

    def test_ignores_records_outside_the_buckets(self):
        buckets = TimeWindow(at(10), at(20)).buckets(timedelta(minutes=10))
        grouped = group_by_bucket([event(minutes=0), event(minutes=15)], buckets)

        self.assertEqual([len(group) for group in grouped], [1])


class StatisticsTests(unittest.TestCase):
    def test_ratio_protects_against_zero(self):
        self.assertEqual(ratio(3, 0), 0.0)
        self.assertEqual(ratio(3, 6), 0.5)

    def test_mean_and_percentile_without_samples(self):
        self.assertIsNone(mean([]))
        self.assertIsNone(percentile([], 95))

    def test_percentile_interpolates(self):
        values = [10, 20, 30, 40]
        self.assertEqual(percentile(values, 0), 10.0)
        self.assertEqual(percentile(values, 50), 25.0)
        self.assertEqual(percentile(values, 100), 40.0)

    def test_percentile_rejects_out_of_range(self):
        with self.assertRaises(ValueError):
            percentile([1, 2], 120)

    def test_pearson_detects_direction(self):
        self.assertAlmostEqual(pearson([1, 2, 3], [2, 4, 6]), 1.0)
        self.assertAlmostEqual(pearson([1, 2, 3], [6, 4, 2]), -1.0)

    def test_pearson_returns_zero_without_variance(self):
        self.assertEqual(pearson([1, 1, 1], [1, 2, 3]), 0.0)
        self.assertEqual(pearson([1], [2]), 0.0)


if __name__ == "__main__":
    unittest.main()
