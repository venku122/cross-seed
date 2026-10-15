import { readFileSync, writeFileSync } from "node:fs";

const quantile = (values, p) => {
	const sorted = values.slice().sort((a, b) => a - b);
	return (
		sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ??
		null
	);
};
const median = (values) => {
	const sorted = values.slice().sort((a, b) => a - b);
	if (!sorted.length) return null;
	return (
		(sorted[Math.floor((sorted.length - 1) / 2)] +
			sorted[Math.floor(sorted.length / 2)]) /
		2
	);
};
const [
	input = "docs/audit/patch02/cleanup-results.json",
	output = "docs/audit/patch02/cleanup-summary.json",
] = process.argv.slice(2);
const raw = JSON.parse(readFileSync(input, "utf8"));
const summaries = raw.scenarios.map((scenario) => {
	const groups = [false, true].map((candidate) =>
		raw.results.filter(
			(result) =>
				result.fixture.count === scenario.paths &&
				result.fixture.delayMs === scenario.delayMs &&
				(result.fixture.missingEvery ?? 0) ===
					(scenario.missingEvery ?? 0) &&
				(result.fs.rootGuardDelayMs ?? 0) ===
					(scenario.rootDelayMs ?? 0) &&
				(result.fixture.mode ?? "cleanup") ===
					(scenario.mode ?? "cleanup") &&
				(result.position === "B") === candidate,
		),
	);
	const metrics = groups.map((group) => {
		const operations = group.flatMap((r) => r.wallMs.raw);
		const ping = group.flatMap((r) => r.http.ping.raw);
		return {
			processes: group.length,
			wallProcessMedianMs: median(group.map((r) => r.wallMs.p50)),
			wallP95Ms: quantile(operations, 0.95),
			wallP99Ms: quantile(operations, 0.99),
			coldMedianMs: median(group.map((r) => r.coldWallMs)),
			warmProcessMedianMs: median(
				group.map((r) => r.warmWallMs.p50).filter((n) => n !== null),
			),
			rssMedianMiB: median(group.map((r) => r.processMaxRssKiB / 1024)),
			heapPeakMedianMiB: median(
				group.map((r) => r.memoryPeak.heapUsed / 1048576),
			),
			cpuMedianMsPerOperation: median(
				group.map(
					(r) =>
						(r.cpuUs.user + r.cpuUs.system) /
						1000 /
						r.fixture.repeats,
				),
			),
			pingSamples: ping.length,
			pingP95Ms: quantile(ping, 0.95),
			pingP99Ms: quantile(ping, 0.99),
			loopP99MedianMs: median(group.map((r) => r.loopMs.p99)),
			loopMaxMedianMs: median(group.map((r) => r.loopMs.max)),
			accessCallsPerOperation: median(
				group.map((r) => r.fs.accessCalls / r.fixture.repeats),
			),
			rootGuardAccessCallsPerOperation: median(
				group.map(
					(r) => (r.fs.rootGuardAccessCalls ?? 0) / r.fixture.repeats,
				),
			),
			sqlCallsPerOperation: median(
				group.map((r) => r.sql.calls / r.fixture.repeats),
			),
			concurrencyMax: Math.max(...group.map((r) => r.fs.maxConcurrency)),
			beforeAfterDriftPct:
				group[0]?.position === "B"
					? null
					: (median(
							group
								.filter((r) => r.position === "A-after")
								.map((r) => r.wallMs.p50),
						) /
							median(
								group
									.filter((r) => r.position === "A-before")
									.map((r) => r.wallMs.p50),
							) -
							1) *
						100,
		};
	});
	return {
		scenario,
		baseline: metrics[0],
		candidate: metrics[1],
		wallChangePct:
			(metrics[1].wallProcessMedianMs / metrics[0].wallProcessMedianMs -
				1) *
			100,
		rssChangePct:
			(metrics[1].rssMedianMiB / metrics[0].rssMedianMiB - 1) * 100,
	};
});
writeFileSync(
	output,
	`${JSON.stringify({ scope: raw.note, sourceIdentities: [...new Set(raw.results.map((r) => `${r.position === "B" ? "candidate" : "baseline"}:${r.sourceSha256}:${r.compiledSha256}`))], method: "Median of independent process medians; pooled operation and HTTP p95/p99 are descriptive. Process counts and operation counts are reported per scenario; A/B/A rounds. Synthetic mock filesystem delays and optional fake-client refresh through real ensemble rebuilding; no real NFS. Large fixtures are cold operations, not warm operation samples.", summaries }, null, 2)}\n`,
);
for (const row of summaries) console.log(JSON.stringify(row));
