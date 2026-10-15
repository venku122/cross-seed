import { PerformanceObserver, performance } from "node:perf_hooks";
const STAGES = ["cachehydrate/publication", "dbapply", "generation", "other"];
const blank = () => Object.fromEntries(STAGES.map((stage) => [stage, 0]));
const number = (value) =>
	typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: 0;
export function gcSummary(entries, begin, end) {
	const pauses = entries
		.map((entry) => ({
			duration: Math.max(
				0,
				Math.min(end, entry.startTime + entry.duration) -
					Math.max(begin, entry.startTime),
			),
			kind: entry.kind ?? entry.detail?.kind,
		}))
		.filter((entry) => entry.duration > 0);
	const durations = pauses
		.map((entry) => entry.duration)
		.sort((a, b) => a - b);
	return {
		events: pauses.length,
		totalPauseMs: durations.reduce((a, b) => a + b, 0),
		maxPauseMs: durations.at(-1) ?? 0,
		p95PauseMs:
			durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)] ?? 0,
		minorEvents: pauses.filter((e) => e.kind === 1).length,
		majorEvents: pauses.filter((e) => e.kind === 4).length,
		incrementalEvents: pauses.filter((e) => e.kind === 8).length,
		weakCallbackEvents: pauses.filter((e) => e.kind === 16).length,
	};
}
export function memorySummary(samples, begin, end) {
	const active = samples.filter(
		(sample) => sample.t >= begin && sample.t <= end,
	);
	let growth = 0;
	for (let i = 1; i < active.length; i++)
		growth += Math.max(
			0,
			number(active[i].heapUsed) - number(active[i - 1].heapUsed),
		);
	return {
		samples: active.map((s) => ({
			offsetMs: s.t - begin,
			rssBytes: number(s.rss),
			mainHeapUsedBytes: number(s.heapUsed),
			mainHeapTotalBytes: number(s.heapTotal),
		})),
		maxSampleGapMs: Math.max(
			0,
			...active.slice(1).map((s, i) => s.t - active[i].t),
		),
		sampleCount: active.length,
		peakRssBytes: Math.max(0, ...active.map((s) => number(s.rss))),
		peakMainHeapUsedBytes: Math.max(
			0,
			...active.map((s) => number(s.heapUsed)),
		),
		positiveHeapGrowthBytes: growth,
		mainHeapScope: "main-thread",
		rssScope: "whole-process-including-workers",
		workerHeapSampled: false,
	};
}
export function stageForFrame(frame = {}) {
	// Inspect private frames in memory only. Publish exactly one fixed stage enum.
	const module = String(frame.url ?? "")
		.split(/[\\/]/)
		.at(-1)
		?.split("?")[0];
	const name = String(frame.functionName ?? "");
	if (["sourceStore.js", "db.js", "ensembleWriter.js"].includes(module))
		return "dbapply";
	if (
		["membershipGeneration.js", "torrent.js", "parse.js"].includes(
			module,
		) ||
		/generate.*(?:Piece|Member|Ensemble)/i.test(name)
	)
		return "generation";
	if (
		[
			"clientCache.js",
			"sourceCoordinator.js",
			"QBittorrent.js",
			"searchee.js",
		].includes(module) ||
		/(?:hydrate|publish|publication)/i.test(name)
	)
		return "cachehydrate/publication";
	return "other";
}
export function aggregateHeapProfile(profile) {
	const stages = blank();
	let nodes = 0;
	function visit(node, inherited = "other") {
		if (!node || typeof node !== "object") return;
		nodes++;
		const classified = stageForFrame(node.callFrame);
		const stage = classified === "other" ? inherited : classified;
		stages[stage] += number(node.selfSize);
		for (const child of Array.isArray(node.children) ? node.children : [])
			visit(child, stage);
	}
	visit(profile.head ?? profile.profile?.head);
	return {
		scope: "isolate-unclassified",
		stages,
		totalSampledHeapBytes: Object.values(stages).reduce((a, b) => a + b, 0),
		nodes,
	};
}
export function aggregateCpuProfile(profile) {
	const nodes = new Map((profile.nodes ?? []).map((node) => [node.id, node])),
		parents = new Map(),
		stages = blank();
	for (const node of nodes.values())
		for (const child of node.children ?? []) parents.set(child, node.id);
	function classify(id) {
		const seen = new Set();
		while (nodes.has(id) && !seen.has(id)) {
			seen.add(id);
			const stage = stageForFrame(nodes.get(id).callFrame);
			if (stage !== "other") return stage;
			id = parents.get(id);
		}
		return "other";
	}
	for (let i = 0; i < (profile.samples ?? []).length; i++)
		stages[classify(profile.samples[i])] += number(profile.timeDeltas?.[i]);
	return {
		scope: "isolate-unclassified",
		stages,
		totalSampledCpuUs: Object.values(stages).reduce((a, b) => a + b, 0),
		samples: profile.samples?.length ?? 0,
	};
}
export function createActiveProfiler(enabled) {
	let begin, end, timer;
	const entries = [],
		samples = [];
	const observer = enabled
		? new PerformanceObserver((list) => {
				for (const entry of list.getEntries())
					entries.push({
						startTime: entry.startTime,
						duration: entry.duration,
						kind: entry.detail.kind,
					});
			})
		: null;
	observer?.observe({ entryTypes: ["gc"] });
	const sample = () =>
		samples.push({ t: performance.now(), ...process.memoryUsage() });
	return {
		begin() {
			if (!enabled) return;
			begin = performance.now();
			sample();
			timer = setInterval(sample, 10);
		},
		async end() {
			if (!enabled) return null;
			end = performance.now();
			sample();
			clearInterval(timer);
			await new Promise((resolve) => setImmediate(resolve));
			for (const entry of observer.takeRecords())
				entries.push({
					startTime: entry.startTime,
					duration: entry.duration,
					kind: entry.detail.kind,
				});
			observer.disconnect();
			return {
				enabled: true,
				activeWindowMs: end - begin,
				gc: gcSummary(entries, begin, end),
				memory: memorySummary(samples, begin, end),
			};
		},
	};
}

// Raw files and identity map belong exclusively to OUTPUT/private.
export async function collectPrivateProfiles(directory) {
	const { readdir, readFile, chmod } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const { createHash } = await import("node:crypto");
	const aggregates = { heap: [], cpu: [], parseFailures: 0 },
		identities = {};
	for (const filename of await readdir(directory)) {
		if (
			!filename.endsWith(".heapprofile") &&
			!filename.endsWith(".cpuprofile")
		)
			continue;
		const path = join(directory, filename);
		await chmod(path, 0o600);
		const bytes = await readFile(path);
		identities[filename] = createHash("sha256").update(bytes).digest("hex");
		try {
			const profile = JSON.parse(bytes);
			if (filename.endsWith(".heapprofile"))
				aggregates.heap.push(aggregateHeapProfile(profile));
			else aggregates.cpu.push(aggregateCpuProfile(profile));
		} catch {
			aggregates.parseFailures++;
		}
	}
	return { aggregates, identities };
}
