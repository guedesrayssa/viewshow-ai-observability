import copy
import unittest

from benchmark import DEFAULT_BUDGET, EvidenceTools, ProtocolError, investigate, validate_diagnosis


def fixture():
    return {"id": "dev-only", "synthetic": True, "cutoff": "2026-01-01T04:00:00Z",
            "signal": {"metric": "bufferratio", "trigger": "ANOMALY_DETECTION"},
            "reference_window": {"start": "2026-01-01T00:00:00Z", "end": "2026-01-01T02:00:00Z", "expected_points": 2},
            "current_window": {"start": "2026-01-01T02:00:00Z", "end": "2026-01-01T04:00:00Z", "expected_points": 2},
            "records": [{"id": f"r{i}", "timestamp": f"2026-01-01T0{i}:00:00Z", "metric": "bufferratio", "scope": "signal:1", "value": value, "unit": "percent", "source": "synthetic"} for i, value in enumerate([1., 1., 4., None, 3., 999.])]}


def diagnosis(ids):
    import json
    return json.dumps({"hypotheses": [{"title": "Dados insuficientes", "explanation": "Aumento sem causa identificada",
        "confidence": 0.2, "supportingEvidenceIds": ids, "contradictingEvidenceIds": [], "missingEvidence": ["capacity"]}]})


class FakeClient:
    def __init__(self, replies):
        self.replies = list(replies)
        self.requests = []

    def chat(self, payload, timeout):
        self.requests.append(copy.deepcopy(payload))
        return self.replies.pop(0)


def reply(content="", calls=None, reason="stop", tokens=30):
    return {"done": True, "done_reason": reason, "eval_count": tokens,
            "message": {"role": "assistant", "content": content, **({"tool_calls": calls} if calls else {})}}


class BenchmarkTests(unittest.TestCase):
    def test_unfinished_hour_is_not_visible_at_cutoff(self):
        case = fixture()
        case['records'][2]['available_at'] = '2026-01-01T05:00:00Z'
        tools = EvidenceTools(case)
        self.assertNotIn('r2', [r['id'] for r in tools.records])

    def test_only_fences_are_normalized_not_invalid_json(self):
        self.assertEqual(len(validate_diagnosis('```json\n' + diagnosis(['r0']) + '\n```', {'r0'})['hypotheses']), 1)
        with self.assertRaises(ProtocolError):
            validate_diagnosis('```json\n{"hypotheses":\n```', {'r0'})

    def test_future_is_not_available_or_citable(self):
        tools = EvidenceTools(fixture())
        rows = tools.call("consultar_serie", {"metrics": ["bufferratio"], "scope": "all"}, 3)["records"]
        self.assertNotIn("r5", {r["id"] for r in rows})
        self.assertNotIn("r5", tools.known)
        with self.assertRaises(ProtocolError):
            validate_diagnosis(diagnosis(["r5"]), tools.known)

    def test_missing_is_not_zero_and_window_end_is_exclusive(self):
        tools = EvidenceTools(fixture())
        c = tools.call("comparar_janelas", {"metrics": ["bufferratio"], "scope": "all"}, 3)["comparisons"][0]
        self.assertEqual(c["current"]["mean"], 4.)
        self.assertEqual(c["current"]["coverage"], .5)
        self.assertEqual(c["delta"], 3.)
        self.assertNotIn("r4", c["source_ids"])

    def test_unavailable_and_invalid_requests_are_distinct(self):
        tools = EvidenceTools(fixture())
        self.assertEqual(tools.call("consultar_serie", {"metrics": ["cpu"], "scope": "all"}, 3)["availability"], "unavailable")
        self.assertEqual(tools.call("shell", {"command": "anything"}, 3)["availability"], "error")
        self.assertEqual(tools.call("consultar_serie", {"metrics": ["bufferratio"], "path": "/etc/passwd"}, 3)["availability"], "error")

    def test_evidence_must_have_been_queried(self):
        with self.assertRaises(ProtocolError):
            validate_diagnosis(diagnosis(["r0"]), EvidenceTools(fixture()).known)

    def test_A_gathers_context_before_one_call(self):
        client = FakeClient([reply(diagnosis(["r2"]))])
        result = investigate(fixture(), "A", 41, client, "fake")
        self.assertEqual(result["status"], "ready")
        self.assertEqual(len(client.requests), 1)
        self.assertEqual(len(result["tool_trace"]), 3)

    def test_B_executes_a_real_tool_then_uses_its_result(self):
        calls = [{"function": {"name": "consultar_serie", "arguments": {"metrics": ["bufferratio"], "scope": "all"}}}]
        client = FakeClient([reply(calls=calls), reply(diagnosis(["r2"]))])
        result = investigate(fixture(), "B", 41, client, "fake")
        self.assertEqual(result["status"], "ready")
        self.assertEqual(len(client.requests), 2)
        self.assertEqual(client.requests[1]["messages"][-1]["role"], "tool")
        self.assertNotIn('999', client.requests[1]["messages"][-1]["content"])

    def test_excess_tool_calls_stop_investigation(self):
        call = {"function": {"name": "consultar_serie", "arguments": {"metrics": ["bufferratio"], "scope": "all"}}}
        result = investigate(fixture(), "B", 41, FakeClient([reply(calls=[call, call, call])]), "fake")
        self.assertEqual(result["status"], "budget_exceeded")
        self.assertEqual(len(result["tool_trace"]), 3)

    def test_truncated_answer_is_not_accepted(self):
        result = investigate(fixture(), "A", 41, FakeClient([reply(diagnosis(["r2"]), reason="length")]), "fake")
        self.assertEqual(result["status"], "budget_exceeded")
        self.assertIsNone(result["diagnosis"])

    def test_missing_usage_stops_unaccounted_generations(self):
        response = reply(diagnosis(["r2"]))
        del response["eval_count"]
        result = investigate(fixture(), "A", 41, FakeClient([response]), "fake")
        self.assertEqual(result["status"], "failed")

    def test_input_budget_prevents_call(self):
        client = FakeClient([])
        result = investigate(fixture(), "A", 41, client, "fake", {**DEFAULT_BUDGET, "input_bytes_per_call": 1})
        self.assertEqual(result["status"], "budget_exceeded")
        self.assertEqual(client.requests, [])

    def test_no_records_do_not_call_model(self):
        case = fixture()
        case["records"] = []
        result = investigate(case, "B", 41, FakeClient([]), "fake")
        self.assertEqual(result["status"], "pending")


if __name__ == "__main__":
    unittest.main()
