import csv
import gzip
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "prepare-argus.py"
SPEC = importlib.util.spec_from_file_location("prepare_argus", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class PrepareArgusTest(unittest.TestCase):
    def test_extracts_training_inputs_without_executing_dump(self):
        sql = """INSERT INTO `signal_bucket` (`bts`,`source`,`entity`,`metric`,`value`) VALUES
(1000,'rpaas','canal-a','errors',1.5);
INSERT INTO `live_qoe_hourly` (`hour_ts`,`sinal`,`sessions`,`errors`,`startup_errors`,`latency_ms_avg`,`latency_ms_p50`,`latency_ms_p95`,`bufferratio_avg`,`jointime_s_avg`,`dropped_frames_avg`,`stalls_avg`,`bitrate_mbps_avg`,`bitrate_mbps_p50`) VALUES
(1000,'canal-a',10,2,1,3,2,4,0.5,1.2,0,1,4.5,4.4);
INSERT INTO `live_active_15min` (`bucket_ts`,`sinal`,`active_sessions`,`active_with_error`,`joins_in_bucket`,`latency_ms_p50`,`latency_ms_p95`,`bufferratio_avg`,`jointime_s_avg`,`dropped_frames_avg`) VALUES
(1000,'canal-a',8,1,3,2,4,0.6,1.1,0);
INSERT INTO `incident_label` (`id`,`tier`,`kind`,`ts_start`,`ts_end`,`severity`,`region`,`services`,`description`,`narrative_md`,`metrics_cited`,`source_doc`,`notes`,`provenance`,`verdict`) VALUES
('i-1',1,'incident',1000,2000,'high',NULL,'[]','descrição','texto','[]','doc',NULL,'rca-confirmed','confirmed');
"""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dump = root / "argus.sql.gz"
            with gzip.open(dump, "wt", encoding="utf-8") as stream:
                stream.write(sql)
            output = root / "prepared"
            manifest = MODULE.prepare(dump, output, True)

            self.assertEqual(manifest["rows"]["live_qoe_hourly"], 1)
            self.assertEqual(manifest["rows"]["detector_vectors"], 8)
            self.assertEqual(manifest["labels_by_provenance"], {"rca-confirmed": 1})
            self.assertTrue(manifest["gzip_crc_verified"])
            self.assertEqual(json.loads((output / "manifest.json").read_text())["source_sha256"], manifest["source_sha256"])
            with gzip.open(output / "detector.csv.gz", "rt", encoding="utf-8") as stream:
                rows = list(csv.DictReader(stream))
            self.assertEqual(rows[0], {"timestamp": "1000", "scope_id": "canal-a", "metric": "active_sessions", "value": "8"})
            self.assertEqual(len(rows), 8)

    def test_refuses_to_overwrite_an_extraction(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "dump.gz"
            source.write_bytes(b"")
            output = root / "prepared"
            output.mkdir()
            with self.assertRaises(SystemExit):
                MODULE.prepare(source, output, False)


if __name__ == "__main__":
    unittest.main()
