import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fixture, load } from "./validate.mjs";

const helpers = [
	"compareFileTrees",
	"compareFileTreesIgnoringNames",
	"getPartialSizeRatio",
	"compareFileTreesPartial",
];
const counts = [1, 20, 100, 1000, 10000];
const distributions = ["unique", "tied"];
const outcomes = ["success", "first-failure", "last-failure"];
const repeats = { 1: 100000, 20: 10000, 100: 1000, 1000: 10, 10000: 1 };
let sink = 0;
async function worker(root, allocations) {
	const runtime = await load(root);
	const rows = [];
	const session = allocations ? new Session() : null;
	if (session) session.connect();
	try {
		for (const distribution of distributions)
			for (const count of counts)
				for (const outcome of outcomes) {
					const args = fixture(count, outcome, distribution);
					for (const helper of helpers) {
						const fn = runtime.implementation[helper];
						const iterations = repeats[count];
						for (
							let i = 0;
							i < Math.min(iterations, count < 1000 ? 2000 : 1);
							i++
						)
							sink += Number(fn(...args));
						globalThis.gc();
						if (session)
							await session.post("HeapProfiler.startSampling", {
								samplingInterval: 4096,
								includeObjectsCollectedByMajorGC: true,
								includeObjectsCollectedByMinorGC: true,
							});
						const startHeap = process.memoryUsage().heapUsed;
						const cpu = process.cpuUsage();
						const start = performance.now();
						for (let i = 0; i < iterations; i++)
							sink += Number(fn(...args));
						const wallMs = performance.now() - start;
						const cpuUsed = process.cpuUsage(cpu);
						const heapGrowth =
							process.memoryUsage().heapUsed - startHeap;
						let sampledAllocationBytes = null;
						if (session) {
							const { profile } = await session.post(
								"HeapProfiler.stopSampling",
							);
							sampledAllocationBytes =
								profile.samples.reduce(
									(sum, sample) => sum + sample.size,
									0,
								) / iterations;
						}
						rows.push({
							distribution,
							count,
							outcome,
							helper,
							iterations,
							wallMs: wallMs / iterations,
							cpuMs:
								(cpuUsed.user + cpuUsed.system) /
								1000 /
								iterations,
							heapGrowthBytes: heapGrowth / iterations,
							sampledAllocationBytes,
						});
					}
				}
		return {
			identity: runtime.identity,
			rows,
			sink,
			maxRssKiB: process.resourceUsage().maxRSS,
		};
	} finally {
		if (session) session.disconnect();
		await runtime.close();
	}
}
function percentile(values, fraction) {
	return values.toSorted((a, b) => a - b)[
		Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)
	];
}
if (process.argv[2] === "--worker") {
	console.log(
		JSON.stringify(
			await worker(process.argv[3], process.argv[4] === "allocations"),
		),
	);
} else {
	const [baseline, candidate, output] = process.argv.slice(2);
	assert(
		baseline && candidate && output,
		"Usage: node --expose-gc benchmark.mjs BASELINE CANDIDATE OUTPUT_JSON",
	);
	const raw = [];
	const script = fileURLToPath(import.meta.url);
	for (let cycle = 0; cycle < 20; cycle++) {
		for (const [phase, root] of [
			["A1", baseline],
			["B", candidate],
			["A2", baseline],
		]) {
			const processResult = spawnSync(
				process.execPath,
				["--expose-gc", script, "--worker", resolve(root)],
				{ encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
			);
			assert.equal(processResult.status, 0, processResult.stderr);
			raw.push({ cycle, phase, ...JSON.parse(processResult.stdout) });
		}
		process.stderr.write(
			`Completed matching A/B/A cycle ${cycle + 1}/20\n`,
		);
	}
	const allocation = [];
	for (let cycle = 0; cycle < 3; cycle++)
		for (const [phase, root] of [
			["A1", baseline],
			["B", candidate],
			["A2", baseline],
		]) {
			const result = spawnSync(
				process.execPath,
				[
					"--expose-gc",
					script,
					"--worker",
					resolve(root),
					"allocations",
				],
				{ encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
			);
			assert.equal(result.status, 0, result.stderr);
			allocation.push({ cycle, phase, ...JSON.parse(result.stdout) });
		}
	const summary = [];
	for (const distribution of distributions)
		for (const count of counts)
			for (const outcome of outcomes)
				for (const helper of helpers) {
					const select = (runs, phase, metric) =>
						runs
							.filter((run) => run.phase === phase)
							.flatMap((run) =>
								run.rows
									.filter(
										(row) =>
											row.distribution === distribution &&
											row.count === count &&
											row.outcome === outcome &&
											row.helper === helper,
									)
									.map((row) => row[metric]),
							);
					const row = { distribution, count, outcome, helper };
					for (const phase of ["A1", "B", "A2"]) {
						row[phase] = {};
						for (const metric of [
							"wallMs",
							"cpuMs",
							"heapGrowthBytes",
						]) {
							const values = select(raw, phase, metric);
							row[phase][metric] = {
								p50: percentile(values, 0.5),
								p95: percentile(values, 0.95),
								samples: values.length,
							};
						}
						row[phase].sampledAllocationBytes = percentile(
							select(allocation, phase, "sampledAllocationBytes"),
							0.5,
						);
					}
					row.wallP50ChangePercent =
						(row.B.wallMs.p50 /
							((row.A1.wallMs.p50 + row.A2.wallMs.p50) / 2) -
							1) *
						100;
					row.wallP95ChangePercent =
						(row.B.wallMs.p95 /
							((row.A1.wallMs.p95 + row.A2.wallMs.p95) / 2) -
							1) *
						100;
					summary.push(row);
				}
	await writeFile(
		output,
		JSON.stringify(
			{
				node: process.version,
				npm: execFileSync("npm", ["--version"], {
					encoding: "utf8",
				}).trim(),
				os: `${platform()} ${release()}`,
				arch: process.arch,
				cpu: cpus()[0].model,
				cores: cpus().length,
				ramBytes: totalmem(),
				runnerSha256: createHash("sha256")
					.update(await readFile(script))
					.digest("hex"),
				method: "20 fresh-process A/B/A interleaved cycles; in-process warmup; wall and CPU per call; separate 3-cycle allocation sampling includes objects collected by GC; heap growth is a proxy, not total allocation; no live client/tracker",
				raw,
				allocation,
				summary,
			},
			null,
			2,
		) + "\n",
	);
	console.log(`Wrote ${summary.length} workload/helper summaries`);
}
