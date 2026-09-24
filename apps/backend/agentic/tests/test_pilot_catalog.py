import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "scripts" / "build-pilot-catalog.py"
SPEC = importlib.util.spec_from_file_location("pilot_catalog", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

class PilotCatalogTest(unittest.TestCase):
    def test_identity_is_stable(self):
        value = MODULE.identity("live_active_15min", "globo-rj", "active_sessions")
        self.assertTrue(value.startswith("ts_"))
        self.assertEqual(len(value), 67)
        self.assertEqual(value, MODULE.identity("live_active_15min", "globo-rj", "active_sessions"))

if __name__ == "__main__":
    unittest.main()
