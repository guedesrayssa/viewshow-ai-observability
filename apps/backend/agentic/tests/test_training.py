import csv, hashlib, json, subprocess, sys, tempfile, unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).parents[1]

class TrainingExportTest(unittest.TestCase):
    def test_exports_auditable_unapproved_bundle_then_explicit_approval(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); qoe=root/"qoe.csv"; detector=root/"detector.csv"; bundle=root/"bundle.json"; approved=root/"approved.json"
            start=datetime(2025,1,1,tzinfo=timezone.utc)
            with qoe.open("w",newline="") as stream:
                writer=csv.writer(stream); writer.writerow(["hour_ts","sinal","bufferratio_avg","sessions","errors","startup_errors"])
                for channel,offset in (("a",0),("b",.02)):
                    for hour in range(240):
                        value=.08+offset+.05*((hour//12)%2)+.01*(hour%5)
                        writer.writerow([int((start+timedelta(hours=hour)).timestamp()*1000),channel,value,100+hour%11,2+hour%4,1+hour%3])
            with detector.open("w",newline="") as stream:
                writer=csv.writer(stream); writer.writerow(["timestamp","scope_id","metric","value"])
                for point in range(200):
                    instant=(start+timedelta(minutes=15*point)).isoformat()
                    writer.writerow([instant,"canal-a","bufferratio_avg",.1+.001*(point%17)])
                    writer.writerow([instant,"canal-a","sessions",100+(point%13)])
            subprocess.run([sys.executable,str(ROOT/"scripts/train-models.py"),"--qoe-csv",str(qoe),"--detector-csv",str(detector),"--output",str(bundle),"--dataset-version","d1","--version","test-1"],check=True,capture_output=True,text=True)
            data=json.loads(bundle.read_text()); self.assertFalse(data["approved"]); self.assertEqual(len(data["forecast"]["trees"]),300)
            self.assertIn("canal-a",data["detection"]["scopes"]); self.assertLess(data["audit"]["test"]["mae"],1)
            self.assertEqual(data["audit"]["selection"]["forecast"]["eligibleChannels"],2)
            self.assertIn("falsePositiveRate",data["audit"]["test"])
            self.assertEqual(data["audit"]["selection"]["detector"]["requiredMetric"],"bufferratio_avg")
            digest=hashlib.sha256(bundle.read_bytes()).hexdigest()
            subprocess.run([sys.executable,str(ROOT/"scripts/approve-model.py"),"--input",str(bundle),"--output",str(approved),"--expected-sha256",digest,"--reference","review-123"],check=True,capture_output=True,text=True)
            decision=json.loads(approved.read_text()); self.assertTrue(decision["approved"]); self.assertEqual(decision["approval"]["sourceSha256"],digest)

if __name__ == "__main__": unittest.main()
