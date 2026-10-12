import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [
	baseline,
	candidate,
	output = "cleanup-results.json",
	roundsArg = "5",
	profile = "original",
] = process.argv.slice(2);
if (!baseline || !candidate)
	throw new Error(
		"Usage: node run-cleanup.mjs BASELINE CANDIDATE OUTPUT [ROUNDS=5] [PROFILE=original|followup]",
	);
const worker = fileURLToPath(new URL("cleanup-worker.mjs", import.meta.url));
const originalScenarios = [
	{ paths: 0, memberships: 5, delayMs: 0, operations: 20 },
	{ paths: 1, memberships: 5, delayMs: 0, operations: 20 },
	{ paths: 100, memberships: 5, delayMs: 0, operations: 20 },
	{ paths: 100, memberships: 5, delayMs: 5, operations: 20 },
	{ paths: 100, memberships: 5, delayMs: 50, operations: 20 },
	{ paths: 40_000, memberships: 5, delayMs: 0, operations: 1 },
	{ paths: 200_000, memberships: 5, delayMs: 0, operations: 1 },
];
const followupScenarios = [
	{
		paths: 40_000,
		memberships: 5,
		delayMs: 0,
		operations: 1,
		rootDelayMs: 5,
		missingEvery: 17,
	},
	{ paths: 40_000, memberships: 5, delayMs: 5, operations: 1 },
	{ paths: 200_000, memberships: 5, delayMs: 5, operations: 1 },
	{ paths: 100, memberships: 5, delayMs: 0, operations: 20, mode: "refresh" },
	{
		paths: 40_000,
		memberships: 5,
		delayMs: 0,
		operations: 1,
		mode: "refresh",
	},
	{
		paths: 200_000,
		memberships: 5,
		delayMs: 0,
		operations: 1,
		mode: "refresh",
	},
];
if (!["original", "followup"].includes(profile))
	throw new Error("Unknown profile");
const scenarios =
	profile === "followup" ? followupScenarios : originalScenarios;
const results = [];
for (const scenario of scenarios) {
	for (let round = 0; round < Number(roundsArg); round++) {
		for (const [position, checkout] of [
			["A-before", baseline],
			["B", candidate],
			["A-after", baseline],
		]) {
			const args = [
				worker,
				resolve(checkout),
				scenario.paths,
				scenario.memberships,
				scenario.delayMs,
				scenario.operations,
				scenario.mode ?? "cleanup",
				scenario.rootDelayMs ?? 0,
				scenario.missingEvery ?? 0,
			].map(String);
			const run = spawnSync(process.execPath, args, {
				encoding: "utf8",
				maxBuffer: 8 * 1024 * 1024,
			});
			if (run.status !== 0)
				throw new Error(
					`Worker failed ${position}: ${run.stderr}\n${run.stdout}`,
				);
			const raw = run.stdout
				.split("\n")
				.find((line) => line.startsWith("BENCH_RESULT "));
			if (!raw) throw new Error(`Worker omitted results: ${run.stdout}`);
			const result = JSON.parse(raw.slice("BENCH_RESULT ".length));
			const remaining =
				scenario.paths -
				(scenario.missingEvery
					? Math.ceil(scenario.paths / scenario.missingEvery)
					: 0);
			if (
				result.remainingData !== remaining ||
				result.remainingEnsemble !== remaining * scenario.memberships ||
				(scenario.mode === "refresh" &&
					(result.refresh.calls !==
						scenario.memberships * scenario.operations ||
						result.refresh.searchees !==
							scenario.paths *
								scenario.memberships *
								scenario.operations)) ||
				result.http.errors ||
				result.integrity[0].integrity_check !== "ok"
			)
				throw new Error("Fixture correctness/integrity/ping failure");
			results.push({ position, round, ...result });
			writeFileSync(
				output,
				`${JSON.stringify({ schema: 1, note: "Synthetic cached paths and optional fake client refresh; production compiled cleanup, ensemble rebuilding and server; mocked access; no real NFS", scenarios, results }, null, 2)}\n`,
			);
			console.log(
				JSON.stringify({
					position,
					round,
					paths: scenario.paths,
					delayMs: scenario.delayMs,
					mode: scenario.mode ?? "cleanup",
					wallP50: result.wallMs.p50,
					maxRssKiB: result.processMaxRssKiB,
					accessCalls: result.fs.accessCalls,
				}),
			);
		}
	}
}
