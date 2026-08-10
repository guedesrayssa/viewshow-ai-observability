from flask import Blueprint, current_app, jsonify

analytics_bp = Blueprint("analytics", __name__, url_prefix="/v1/analytics")


def _store() -> dict[str, list[dict]]:
    return current_app.config["TELEMETRY_STORE"]


@analytics_bp.get("/realtime/overview")
def realtime_overview():
    data = _store()
    return jsonify(
        {
            "ccu": len(data["heartbeats"]),
            "events_received": len(data["events"]),
            "errors_received": len(data["errors"]),
            "error_rate": len(data["errors"]) / max(len(data["events"]), 1),
        }
    )


@analytics_bp.get("/realtime/alerts")
def realtime_alerts():
    return jsonify({"alerts": []})


@analytics_bp.get("/qoe/metrics")
def qoe_metrics():
    return jsonify({"vst_ms": 0, "rebuffer_rate": 0, "average_bitrate_kbps": 0})


@analytics_bp.get("/qoe/timeseries")
def qoe_timeseries():
    return jsonify({"points": []})


@analytics_bp.get("/errors/summary")
def errors_summary():
    data = _store()
    errors = len(data["errors"])
    sessions = max(len(data["heartbeats"]), 1)
    return jsonify({"total_errors": errors, "error_rate": errors / sessions, "crash_free_rate": 1 - min(errors / sessions, 1)})


@analytics_bp.get("/errors/top")
def top_errors():
    error_counts: dict[str, int] = {}
    for error in _store()["errors"]:
        code = str(error.get("error_code", "UNKNOWN"))
        error_counts[code] = error_counts.get(code, 0) + 1

    ranking = [
        {"error_code": code, "occurrences": occurrences}
        for code, occurrences in sorted(error_counts.items(), key=lambda item: item[1], reverse=True)
    ]
    return jsonify({"errors": ranking})


@analytics_bp.get("/errors/<string:error_code>/details")
def error_details(error_code: str):
    matches = [error for error in _store()["errors"] if str(error.get("error_code", "UNKNOWN")) == error_code]
    return jsonify({"error_code": error_code, "occurrences": len(matches), "errors": matches})


@analytics_bp.get("/breakdown/devices")
def devices_breakdown():
    return jsonify({"breakdown": []})


@analytics_bp.get("/breakdown/network")
def network_breakdown():
    return jsonify({"breakdown": []})
