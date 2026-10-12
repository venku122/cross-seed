import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Session } from "node:inspector/promises";
import { cpus, platform, release } from "node:os";
import { fixture, load } from "./validate.mjs";

const counts = [1, 20, 127, 128, 129, 1000, 10000];
const cases = [
	["exact", "strict"],
	["renamed", "flexible"],
	["first-reject", "strict"],
	["last-reject", "strict"],
	["partial", "partial"],
	["partial-reject", "partial"],
	["strict-renamed", "strict"],
];
// Sensitivity models, not observed tracker frequencies.
const mixes = {
	successHeavy: {
		exact: 0.8,
		renamed: 0.1,
		"first-reject": 0.05,
		"last-reject": 0.03,
		partial: 0.02,
	},
	rejectionHeavy: { exact: 0.01, renamed: 0.04, "first-reject": 0.95 },
	partialHeavy: { exact: 0.1, partial: 0.45, "partial-reject": 0.45 },
};
async function worker(root, allocations) {
	const runtime = await load(root);
	const { Metafile } = await import(
		pathToFileURL(resolve(root, "cross-seed/dist/parseTorrent.js")).href
	);
	runtime.setConfig({ fuzzySizeThreshold: 0.02, seasonFromEpisodes: 1 });
	const rows = [];
	const session = allocations ? new Session() : null;
	session?.connect();
	try {
		for (const distribution of ["unique", "tied"])
			for (const count of allocations ? [10000] : counts)
				for (const [outcome, mode] of cases) {
					const [data, source] = fixture(
						count,
						"success",
						distribution,
					);
					if (outcome.includes("renamed"))
						data.files = data.files.map((f) => ({
							...f,
							path: `other/${f.name}`,
						}));
					if (outcome === "first-reject" || outcome === "partial")
						data.files[0].length = 1;
					if (outcome === "last-reject") data.files.at(-1).length = 1;
					if (outcome === "partial-reject")
						for (let i = 0; i < Math.ceil(count * 0.1); i++)
							data.files[i].length = 999999;
					data.length = data.files.reduce(
						(sum, f) => sum + f.length,
						0,
					);
					const meta = new Metafile({
						info: {
							name: Buffer.from("synthetic"),
							length: data.length,
							"piece length": 16,
							pieces: Buffer.alloc(20),
							private: 0,
						},
					});
					meta.files = data.files;
					const args = [
						meta,
						{ ...source, label: "search" },
						new Set(),
						[],
						{ configOverride: { matchMode: mode } },
					];
					const fn = () =>
						runtime.implementation.assessCandidate(...args);
					const expected = (await fn()).decision;
					const iterations =
						count === 1
							? 30000
							: count < 130
								? 300
								: count < 10000
									? 5
									: 1;
					for (
						let i = 0;
						i < Math.min(iterations, count < 130 ? 3000 : 3);
						i++
					)
						assert.equal((await fn()).decision, expected);
					globalThis.gc();
					if (session)
						await session.post("HeapProfiler.startSampling", {
							samplingInterval: 4096,
							includeObjectsCollectedByMajorGC: true,
							includeObjectsCollectedByMinorGC: true,
						});
					const memoryBefore = process.memoryUsage();
					const heap = memoryBefore.heapUsed;
					const cpu = process.cpuUsage();
					const start = performance.now();
					for (let i = 0; i < iterations; i++)
						assert.equal((await fn()).decision, expected);
					const wallMs = (performance.now() - start) / iterations;
					const cpuUsed = process.cpuUsage(cpu);
					const memoryAfter = process.memoryUsage();
					const heapGrowthBytes =
						(memoryAfter.heapUsed - heap) / iterations;
					const arrayBufferGrowthBytes =
						(memoryAfter.arrayBuffers - memoryBefore.arrayBuffers) /
						iterations;
					let sampledAllocationBytes = null;
					if (session) {
						const { profile } = await session.post(
							"HeapProfiler.stopSampling",
						);
						sampledAllocationBytes =
							profile.samples.reduce((s, x) => s + x.size, 0) /
							iterations;
					}
					rows.push({
						distribution,
						count,
						outcome,
						mode,
						decision: expected,
						iterations,
						wallMs,
						cpuMs:
							(cpuUsed.user + cpuUsed.system) / 1000 / iterations,
						heapGrowthBytes,
						arrayBufferGrowthBytes,
						sampledAllocationBytes,
					});
				}
		return {
			identity: runtime.identity,
			rows,
			maxRssKiB: process.resourceUsage().maxRSS,
		};
	} finally {
		session?.disconnect();
		await runtime.close();
	}
}
const percentile = (values, p) =>
	values.toSorted((a, b) => a - b)[
		Math.min(values.length - 1, Math.ceil(values.length * p) - 1)
	];
if (process.argv[2] === "--worker")
	console.log(
		JSON.stringify(
			await worker(process.argv[3], process.argv[4] === "allocations"),
		),
	);
else {
	const [baseline, candidate, output] = process.argv.slice(2);
	assert(
		baseline && candidate && output,
		"Usage: node --expose-gc assessment-benchmark.mjs BASELINE CANDIDATE OUTPUT",
	);
	const cycles = Number(process.env.MATCHING_CYCLES ?? 12);
	const allocationCycles = Number(
		process.env.MATCHING_ALLOCATION_CYCLES ?? 3,
	);
	const raw = [],
		allocation = [];
	for (const [runs, n, allocationFlag] of [
		[raw, cycles, false],
		[allocation, allocationCycles, true],
	])
		for (let cycle = 0; cycle < n; cycle++) {
			for (const [phase, root] of [
				["A1", baseline],
				["B", candidate],
				["A2", baseline],
			]) {
				const child = spawnSync(
					process.execPath,
					[
						"--expose-gc",
						fileURLToPath(import.meta.url),
						"--worker",
						resolve(root),
						...(allocationFlag ? ["allocations"] : []),
					],
					{ encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
				);
				assert.equal(child.status, 0, child.stderr);
				runs.push({ cycle, phase, ...JSON.parse(child.stdout) });
			}
			process.stderr.write(
				`Assessment ${allocationFlag ? "allocation" : "timing"} cycle ${cycle + 1}/${n}\n`,
			);
		}
	const summary = raw[0].rows.map((template) => {
		const row = {
			distribution: template.distribution,
			count: template.count,
			outcome: template.outcome,
			mode: template.mode,
			decision: template.decision,
		};
		const same = (x) =>
			x.distribution === row.distribution &&
			x.count === row.count &&
			x.outcome === row.outcome;
		for (const phase of ["A1", "B", "A2"]) {
			const select = (runs) =>
				runs
					.filter((r) => r.phase === phase)
					.flatMap((r) => r.rows.filter(same));
			const values = select(raw);
			assert(
				values.every((x) => x.decision === row.decision),
				"Decision differential failed",
			);
			row[phase] = Object.fromEntries(
				[
					"wallMs",
					"cpuMs",
					"heapGrowthBytes",
					"arrayBufferGrowthBytes",
				].map((metric) => [
					metric,
					{
						p50: percentile(
							values.map((x) => x[metric]),
							0.5,
						),
						p95: percentile(
							values.map((x) => x[metric]),
							0.95,
						),
					},
				]),
			);
			const sampled = select(allocation);
			if (sampled.length)
				row[phase].sampledAllocationBytes = percentile(
					sampled.map((x) => x.sampledAllocationBytes),
					0.5,
				);
		}
		return row;
	});
	const weighted = [];
	for (const distribution of ["unique", "tied"])
		for (const count of counts)
			for (const [mix, weights] of Object.entries(mixes)) {
				const phases = {};
				for (const phase of ["A1", "B", "A2"])
					phases[phase] = Object.entries(weights).reduce(
						(sum, [outcome, weight]) =>
							sum +
							weight *
								summary.find(
									(x) =>
										x.distribution === distribution &&
										x.count === count &&
										x.outcome === outcome,
								)[phase].wallMs.p50,
						0,
					);
				weighted.push({
					distribution,
					count,
					mix,
					weights,
					...phases,
					changePercent:
						100 * (phases.B / ((phases.A1 + phases.A2) / 2) - 1),
				});
			}
	await writeFile(
		output,
		JSON.stringify(
			{
				runtime: process.version,
				hardware: cpus()[0].model,
				platform: platform(),
				release: release(),
				scope: "Compiled assessCandidate with already parsed Metafile; excludes snatch/cache/network/injection. Synthetic sensitivity mixes.",
				raw,
				allocation,
				summary,
				weighted,
			},
			null,
			2,
		) + "\n",
	);
}
