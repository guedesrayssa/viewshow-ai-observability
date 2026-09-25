import importlib.util
import sys
import unittest
from pathlib import Path

PATH = Path(__file__).parents[1] / "src" / "view_show_ingestion" / "facts.py"
SPEC = importlib.util.spec_from_file_location("view_show_ingestion_facts", PATH)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)
SeriesIdentity, build_fact, series_id = MODULE.SeriesIdentity, MODULE.build_fact, MODULE.series_id

class FactContractTest(unittest.TestCase):
    def setUp(self):
        self.identity = SeriesIdentity("live_active_15min", "argus", "globo-rj",
                                       "active_sessions", {"channel": "globo-rj"})

    def test_series_id_matches_analysis_runtime(self):
        self.assertEqual(series_id(self.identity),
                         "ts_39328613a9667d827a298acd1cde08c064374a42764895e5e302f580f55b1b04")

    def test_builds_partition_and_payload_expected_by_reader(self):
        item = build_fact(dataset_version="argus-2026-09-01", identity=self.identity,
                          observed_at="2026-08-02T00:00:00Z", grain_seconds=900,
                          unit="count", value=120)
        self.assertEqual(item["pk"], "DATASET#argus-2026-09-01#FACT#TS#" + series_id(self.identity) + "#20260802")
        self.assertEqual(item["sk"], "T#1785628800")
        self.assertEqual(item["payload"]["metric"], {"name": "active_sessions", "unit": "count", "value": 120})

    def test_rejects_unaligned_or_non_finite_fact(self):
        with self.assertRaisesRegex(ValueError, "aligned"):
            build_fact(dataset_version="d", identity=self.identity, observed_at="2026-08-02T00:01:00Z",
                       grain_seconds=900, unit="count", value=1)
        with self.assertRaisesRegex(ValueError, "finite"):
            build_fact(dataset_version="d", identity=self.identity, observed_at="2026-08-02T00:00:00Z",
                       grain_seconds=900, unit="count", value=float("nan"))

if __name__ == "__main__":
    unittest.main()
