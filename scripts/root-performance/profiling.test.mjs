import { test } from "node:test";
import assert from "node:assert/strict";
import {
	gcSummary,
	memorySummary,
	aggregateHeapProfile,
	aggregateCpuProfile,
} from "./profiling.mjs";
test("GC pauses are clipped to actual active interval, including crossing events", () => {
	assert.deepEqual(
		gcSummary(
			[
				{ startTime: 0, duration: 2, kind: 1 },
				{ startTime: 9, duration: 3, kind: 4 },
				{ startTime: 13, duration: 2, kind: 1 },
				{ startTime: 18, duration: 4, kind: 1 },
				{ startTime: 25, duration: 8, kind: 4 },
			],
			10,
			20,
		),
		{
			events: 3,
			totalPauseMs: 6,
			maxPauseMs: 2,
			p95PauseMs: 2,
			minorEvents: 2,
			majorEvents: 1,
			incrementalEvents: 0,
			weakCallbackEvents: 0,
		},
	);
});
test("memory aggregate excludes idle samples and labels growth proxy accurately", () => {
	const result = memorySummary(
		[
			{ t: 0, rss: 100, heapUsed: 10 },
			{ t: 11, rss: 30, heapUsed: 10 },
			{ t: 12, rss: 50, heapUsed: 15 },
			{ t: 13, rss: 40, heapUsed: 12 },
			{ t: 14, rss: 30, heapUsed: 20 },
			{ t: 25, rss: 100, heapUsed: 80 },
		],
		10,
		20,
	);
	assert.equal(result.peakRssBytes, 50);
	assert.equal(result.positiveHeapGrowthBytes, 13);
	assert.equal(result.sampleCount, 4);
	assert.equal(result.workerHeapSampled, false);
});
test("heap parser emits fixed stages and numbers, never frame names or URLs", () => {
	const result = aggregateHeapProfile({
		head: {
			id: 1,
			selfSize: 2,
			callFrame: {
				functionName: "private secret",
				url: "/private/hashes",
			},
			children: [
				{
					id: 2,
					selfSize: 30,
					callFrame: {
						functionName: "hydrateClientCache",
						url: "/private/clientCache.js",
					},
					children: [
						{
							id: 3,
							selfSize: 70,
							callFrame: {
								functionName: "secret torrent name",
								url: "/private/secret-path",
							},
						},
					],
				},
				{
					id: 4,
					selfSize: 20,
					callFrame: {
						functionName: "generatePieces",
						url: "/private/membershipGeneration.js",
					},
				},
			],
		},
	});
	assert.equal(result.stages["cachehydrate/publication"], 100);
	assert.equal(result.stages.generation, 20);
	assert.equal(result.totalSampledHeapBytes, 122);
	assert.ok(!JSON.stringify(result).includes("private"));
	assert.ok(!JSON.stringify(result).includes("secret"));
});
test("CPU parser uses sampled deltas and fixed stage inheritance", () => {
	const result = aggregateCpuProfile({
		nodes: [
			{
				id: 1,
				callFrame: { functionName: "private", url: "/private" },
				children: [2],
			},
			{
				id: 2,
				callFrame: {
					functionName: "apply",
					url: "/private/sourceStore.js",
				},
			},
		],
		samples: [1, 2, 2],
		timeDeltas: [100, 200, 300],
	});
	assert.equal(result.stages.dbapply, 500);
	assert.equal(result.totalSampledCpuUs, 600);
	assert.ok(!JSON.stringify(result).includes("private"));
});

test("raw profile permissions and identities stay separate from publishable summaries", async () => {
	const { mkdtemp, writeFile, stat, rm } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const { tmpdir } = await import("node:os");
	const { collectPrivateProfiles } = await import("./profiling.mjs");
	const directory = await mkdtemp(join(tmpdir(), "profile-smoke-"));
	try {
		await writeFile(
			join(directory, "private-secret.heapprofile"),
			JSON.stringify({
				head: {
					id: 1,
					selfSize: 10,
					callFrame: {
						functionName: "private secret",
						url: "/private/path",
					},
				},
			}),
		);
		await writeFile(
			join(directory, "private-secret.cpuprofile"),
			JSON.stringify({ nodes: [], samples: [], timeDeltas: [] }),
		);
		await writeFile(
			join(directory, "broken.heapprofile"),
			"broken private data",
		);
		const { aggregates, identities } =
			await collectPrivateProfiles(directory);
		assert.equal(aggregates.parseFailures, 1);
		assert.equal(aggregates.heap[0].totalSampledHeapBytes, 10);
		assert.ok(!JSON.stringify(aggregates).includes("private"));
		assert.equal(Object.keys(identities).length, 3);
		assert.equal(
			(await stat(join(directory, "private-secret.heapprofile"))).mode &
				0o777,
			0o600,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("profile publication drops private and arbitrary fields", async () => {
	const { publishProfiling } = await import("./privacy.mjs");
	const output = publishProfiling({
		enabled: true,
		path: "/private",
		activeWindowMs: 5,
		gc: { events: 2, totalPauseMs: 3, names: ["private"] },
		memory: {
			peakRssBytes: 10,
			peakMainHeapUsedBytes: "/private",
			workerHeapSampled: true,
		},
	});
	assert.ok(!JSON.stringify(output).includes("private"));
	assert.equal(output.memory.workerHeapSampled, false);
	assert.equal(output.gc.events, 2);
});

test("profiled and unprofiled controllers share one exclusive comparative slot", async () => {
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const { tmpdir } = await import("node:os");
	const { claimComparativeSlot } = await import("./slot.mjs");
	const directory = await mkdtemp(join(tmpdir(), "slot-smoke-"));
	try {
		const path = join(directory, "slot");
		const release = claimComparativeSlot(path);
		assert.throws(() => claimComparativeSlot(path), /slot occupied/);
		release();
		const second = claimComparativeSlot(path);
		second();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Node profiler flags produce parseable private CPU and sampled heap captures", async () => {
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const { tmpdir } = await import("node:os");
	const { execFileSync } = await import("node:child_process");
	const { collectPrivateProfiles } = await import("./profiling.mjs");
	const directory = await mkdtemp(join(tmpdir(), "node-profiler-smoke-"));
	try {
		execFileSync(
			process.execPath,
			[
				"--cpu-prof",
				`--cpu-prof-dir=${directory}`,
				"--cpu-prof-interval=1000",
				"--heap-prof",
				`--heap-prof-dir=${directory}`,
				"--heap-prof-interval=32768",
				"--eval",
				"globalThis.syntheticFixture=Array.from({length:1000},(_,i)=>({value:i}));",
			],
			{ stdio: "pipe" },
		);
		const { aggregates } = await collectPrivateProfiles(directory);
		assert.equal(aggregates.parseFailures, 0);
		assert.equal(aggregates.heap.length, 1);
		assert.equal(aggregates.cpu.length, 1);
		assert.ok(aggregates.heap[0].totalSampledHeapBytes > 0);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
