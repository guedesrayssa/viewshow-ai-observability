"""Garante que a API pública de fatos continua exposta por ``view_show_ingestion``."""

import unittest

from view_show_ingestion import SeriesIdentity, build_fact, series_id


class FactContractTest(unittest.TestCase):
    def setUp(self):
        self.identity = SeriesIdentity(
            "live_active_15min", "argus", "globo-rj", "active_sessions", {"channel": "globo-rj"}
        )

    def test_series_id_matches_analysis_runtime(self):
        self.assertEqual(
            series_id(self.identity),
            "ts_39328613a9667d827a298acd1cde08c064374a42764895e5e302f580f55b1b04",
        )

    def test_builds_partition_and_payload_expected_by_reader(self):
        item = build_fact(
            dataset_version="argus-2026-09-01",
            identity=self.identity,
            observed_at="2026-08-02T00:00:00Z",
            grain_seconds=900,
            unit="count",
            value=120,
        )
        sid = series_id(self.identity)
        self.assertEqual(item["pk"], f"DATASET#argus-2026-09-01#FACT#TS#{sid}#20260802")
        self.assertEqual(item["sk"], "T#1785628800000#" + item["recordId"])
        self.assertEqual(item["itemType"], "time-series-fact")
        self.assertEqual(item["observedAt"], "2026-08-02T00:00:00.000Z")
        self.assertEqual(
            item["payload"]["metric"], {"name": "active_sessions", "unit": "count", "value": 120}
        )

    def test_rejects_unaligned_or_non_finite_fact(self):
        with self.assertRaisesRegex(ValueError, "aligned"):
            build_fact(
                dataset_version="d",
                identity=self.identity,
                observed_at="2026-08-02T00:01:00Z",
                grain_seconds=900,
                unit="count",
                value=1,
            )
        with self.assertRaisesRegex(ValueError, "finite"):
            build_fact(
                dataset_version="d",
                identity=self.identity,
                observed_at="2026-08-02T00:00:00Z",
                grain_seconds=900,
                unit="count",
                value=float("nan"),
            )


if __name__ == "__main__":
    unittest.main()
