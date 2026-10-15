// Closed numeric/boolean telemetry whitelist. Never recursively copy unknown keys.
const fields = {
	wallMs: ["n", "p50", "p95", "p99", "max", "raw"],
	warmWallMs: ["n", "p50", "p95", "p99", "max", "raw"],
	cpuUs: ["user", "system"],
	memoryBefore: ["rss", "heapTotal", "heapUsed", "external", "arrayBuffers"],
	memoryPeak: ["rss", "heapTotal", "heapUsed", "external", "arrayBuffers"],
	loopMs: ["p95", "p99", "max"],
	sql: ["calls", "durationMs", "maxStatementMs", "applyMs"],
	adapter: [
		"requestBytes",
		"responseBytes",
		"fileJsonReadBytes",
		"insertBindingBytes",
	],
	refresh: ["calls", "searchees"],
	fs: [
		"accessCalls",
		"rootGuardAccessCalls",
		"maxConcurrency",
		"rootGuardDelayMs",
	],
	housekeeping: [
		"expiredCacheRemoved",
		"expiredDecisionRemoved",
		"obsoletePathRemoved",
	],
};
const scalars = [
	"rawDataRows",
	"rawLegacyMembershipRows",
	"rawOwnedMembershipRows",
	"ownedMembershipRows",
	"coldWallMs",
	"processMaxRssKiB",
	"cacheRows",
	"cacheFileJsonBytes",
	"remainingData",
	"remainingEnsemble",
];
const safe = (v) =>
	typeof v === "boolean" ||
	(typeof v === "number" && Number.isFinite(v)) ||
	v === null;
export function publish(input) {
	const output = {};
	for (const name of scalars)
		if (safe(input[name])) output[name] = input[name];
	for (const [section, names] of Object.entries(fields)) {
		if (!input[section]) continue;
		output[section] = {};
		for (const name of names) {
			const value = input[section][name];
			if (safe(value)) output[section][name] = value;
			else if (
				name === "raw" &&
				Array.isArray(value) &&
				value.every(safe)
			)
				output[section][name] = value;
		}
	}
	return output;
}
export function fixtureFileCount(index, shape) {
	if (shape !== "observed") {
		const count = Number(shape);
		if (!Number.isSafeInteger(count) || count < 1 || count > 100000)
			throw new Error("Invalid file shape");
		return count;
	}
	const n = index % 8194;
	if (n < 4971) return 1;
	if (n < 7840) return 2 + (n % 23);
	if (n < 8132) return 25 + (n % 76);
	if (n < 8182) return 101 + (n % 900);
	if (n < 8192) return 1001 + (n % 9000);
	return 10001 + (n % 1000);
}

export function publishHttp(input) {
	const numeric = [
		"rate",
		"timeoutMs",
		"activeWindowMs",
		"drainMs",
		"attempts",
		"completed",
		"timeouts",
		"errors",
	];
	const output = Object.fromEntries(
		numeric
			.filter(
				(k) =>
					typeof input[k] === "number" && Number.isFinite(input[k]),
			)
			.map((k) => [k, input[k]]),
	);
	output.samples = (Array.isArray(input.samples) ? input.samples : []).map(
		(sample) => ({
			...Object.fromEntries(
				["scheduledMs", "generatorLagMs", "latencyMs", "endToEndMs"]
					.filter(
						(k) =>
							typeof sample[k] === "number" &&
							Number.isFinite(sample[k]),
					)
					.map((k) => [k, sample[k]]),
			),
			outcome: ["completed", "timeout", "error"].includes(sample.outcome)
				? sample.outcome
				: "error",
		}),
	);
	return output;
}

export function publishProfiling(input) {
	if (!input) return null;
	const select = (object, keys) =>
		Object.fromEntries(
			keys
				.filter(
					(key) =>
						typeof object?.[key] === "number" &&
						Number.isFinite(object[key]),
				)
				.map((key) => [key, object[key]]),
		);
	return {
		enabled: input.enabled === true,
		...select(input, ["activeWindowMs"]),
		gc: select(input.gc, [
			"events",
			"totalPauseMs",
			"maxPauseMs",
			"p95PauseMs",
			"minorEvents",
			"majorEvents",
			"incrementalEvents",
			"weakCallbackEvents",
		]),
		memory: {
			...select(input.memory, [
				"sampleCount",
				"maxSampleGapMs",
				"peakRssBytes",
				"peakMainHeapUsedBytes",
				"positiveHeapGrowthBytes",
			]),
			samples: (Array.isArray(input.memory?.samples)
				? input.memory.samples
				: []
			).map((sample) =>
				select(sample, [
					"offsetMs",
					"rssBytes",
					"mainHeapUsedBytes",
					"mainHeapTotalBytes",
				]),
			),
			mainHeapScope: "main-thread",
			rssScope: "whole-process-including-workers",
			workerHeapSampled: false,
		},
	};
}
