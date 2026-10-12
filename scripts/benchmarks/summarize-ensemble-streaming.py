"""Summarize external five-round captures; do not run during comparative timing."""
import hashlib
import json
import math
import statistics
import sys
from pathlib import Path


def quantiles(values):
    values = sorted(values)
    if not values:
        return {"n": 0, "p50": None, "p95": None, "p99": None, "min": None, "max": None}
    at = lambda p: values[min(len(values) - 1, math.ceil(p * len(values)) - 1)]
    return {"n": len(values), "p50": statistics.median(values), "p95": at(.95),
            "p99": at(.99), "min": values[0], "max": values[-1]}


root = Path(sys.argv[1])
raw = root / "samples.jsonl"
samples = [json.loads(line) for line in raw.open()]
assert len(samples) == 420
metrics = {
    "wallMs": lambda x: x["wallMs"]["p50"],
    "cpuMs": lambda x: sum(x["cpuUs"].values()) / 1000,
    "sampledPeakRssMiB": lambda x: x["memoryPeak"]["rss"] / 1048576,
    "sampledPeakHeapMiB": lambda x: x["memoryPeak"]["heapUsed"] / 1048576,
    "processMaxRssMiB": lambda x: x["processMaxRssKiB"] / 1024,
    "loopP99Ms": lambda x: x["loopMs"]["p99"],
    "loopMaxMs": lambda x: x["loopMs"]["max"],
    "httpP99Ms": lambda x: x["http"]["ping"]["p99"],
    "httpMaxMs": lambda x: x["http"]["ping"]["max"],
    "httpObservations": lambda x: x["http"]["ping"]["n"],
    "sqlReaderP99Ms": lambda x: x["sqlReaderLatencyMs"]["p99"],
    "sqlCalls": lambda x: x["sql"]["calls"],
    "maxStatementMs": lambda x: x["sql"]["maxStatementMs"],
    "finalApplyMs": lambda x: x["sql"]["applyMs"],
    "elu": lambda x: x["elu"]["utilization"],
}
groups = {}
for sample in samples:
    groups.setdefault(json.dumps(sample["fixture"], sort_keys=True), []).append(sample)
cases = []
for key, rows in groups.items():
    assert len(rows) == 15
    assert len({x["membershipDigest"] for x in rows}) == 1
    item = {"fixture": json.loads(key), "phases": {}}
    for phase in ["A1", "B", "A2", "base"]:
        selected = [x for x in rows if x["phase"] == phase or
                    phase == "base" and x["phase"] != "B"]
        item["phases"][phase] = {
            metric: quantiles([value for x in selected if (value := extract(x)) is not None])
            for metric, extract in metrics.items()
        }
        for metric, extract in [
            ("pooledHttpMs", lambda x: x["http"]["ping"]["raw"]),
            ("pooledSqlReaderMs", lambda x: x["sqlReaderLatencyMs"]["raw"]),
        ]:
            item["phases"][phase][metric] = quantiles([v for x in selected for v in extract(x)])
    baseline, candidate = item["phases"]["base"], item["phases"]["B"]
    item["changesPercent"] = {
        key: (candidate[key]["p50"] / baseline[key]["p50"] - 1) * 100
        for key in metrics if baseline[key]["p50"] and candidate[key]["p50"] is not None
    }
    cases.append(item)
summary = {
    "success": True, "workers": 420, "fixtureCount": 28, "rounds": 5,
    "sourceCommit": "baf8944aabb259f82bb54c8e1ad35ddc7a5baf89",
    "baselineCommit": "d330de4986c562406c71613e1f3a8953e8d5ccb6",
    "rawSha256": hashlib.sha256(raw.read_bytes()).hexdigest(),
    "quantileNote": "p50 median of per-worker statistics. Five head values make p95/p99 their maximum; pooled HTTP has its actual observation count. Setup excluded from wall/CPU; process RSS includes setup. No invocation weighting.",
    "cases": cases,
    "regressionsOver5Percent": [
        {"fixture": c["fixture"], "changesPercent": {k: v for k, v in c["changesPercent"].items() if v > 5}}
        for c in cases if any(v > 5 for v in c["changesPercent"].values())
    ],
}
(root / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps({"success": True, "workers": len(samples), "fixtures": len(cases), "rawSha256": summary["rawSha256"]}))
