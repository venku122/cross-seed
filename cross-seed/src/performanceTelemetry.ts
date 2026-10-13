/** Numeric, bounded telemetry. Arbitrary identifiers never enter the recorder. */
export type PerformanceOperation =
	| "candidate"
	| "ensemble-lookup"
	| "sqlite-query"
	| "client-rpc"
	| "client-refresh"
	| "cleanup"
	| "ensemble-rebuild"
	| "health";
export type CacheOutcome = "hit" | "miss" | "none";
const operations: PerformanceOperation[] = [
	"candidate",
	"ensemble-lookup",
	"sqlite-query",
	"client-rpc",
	"client-refresh",
	"cleanup",
	"ensemble-rebuild",
	"health",
];
const buckets = [
	"0",
	"1",
	"2-24",
	"25-100",
	"101-1000",
	"1001-10000",
	">10000",
] as const;
type FileBucket = (typeof buckets)[number];
export function fileCountBucket(count: number): FileBucket {
	if (!Number.isSafeInteger(count) || count < 0)
		throw new Error("Invalid file count");
	if (count === 0) return "0";
	if (count === 1) return "1";
	if (count <= 24) return "2-24";
	if (count <= 100) return "25-100";
	if (count <= 1000) return "101-1000";
	if (count <= 10000) return "1001-10000";
	return ">10000";
}
export interface PerformanceEvent {
	operation: PerformanceOperation;
	durationMs: number;
	fileCount?: number;
	cache?: CacheOutcome;
	rpcBytes?: number;
	sqlQueries?: number;
	ensembleRows?: number;
}
function createCounters() {
	return {
		count: 0,
		durationMs: { total: 0, maximum: 0 },
		fileCounts: Object.fromEntries(
			buckets.map((bucket) => [bucket, 0]),
		) as Record<FileBucket, number>,
		cache: { hit: 0, miss: 0, none: 0 },
		rpcBytes: 0,
		sqlQueries: 0,
		ensembleRows: 0,
	};
}
export class PerformanceRecorder {
	private readonly counters = Object.fromEntries(
		operations.map((operation) => [operation, createCounters()]),
	) as Record<PerformanceOperation, ReturnType<typeof createCounters>>;
	record(event: PerformanceEvent): void {
		if (!operations.includes(event.operation))
			throw new Error("Invalid performance operation");
		const cache = event.cache ?? "none";
		if (!["hit", "miss", "none"].includes(cache))
			throw new Error("Invalid cache outcome");
		if (!Number.isFinite(event.durationMs) || event.durationMs < 0)
			throw new Error("Invalid duration");
		for (const value of [
			event.rpcBytes,
			event.sqlQueries,
			event.ensembleRows,
		]) {
			if (
				value !== undefined &&
				(!Number.isSafeInteger(value) || value < 0)
			)
				throw new Error("Invalid performance counter");
		}
		const bucket =
			event.fileCount === undefined
				? undefined
				: fileCountBucket(event.fileCount);
		const counter = this.counters[event.operation];
		counter.count++;
		counter.durationMs.total += event.durationMs;
		counter.durationMs.maximum = Math.max(
			counter.durationMs.maximum,
			event.durationMs,
		);
		if (bucket) counter.fileCounts[bucket]++;
		counter.cache[cache]++;
		counter.rpcBytes += event.rpcBytes ?? 0;
		counter.sqlQueries += event.sqlQueries ?? 0;
		counter.ensembleRows += event.ensembleRows ?? 0;
	}
	snapshot(): Record<
		PerformanceOperation,
		ReturnType<typeof createCounters>
	> {
		return structuredClone(this.counters);
	}
}
// Explicit opt-in; callers pass only the numeric event above, never source objects.
export const performanceRecorder = new PerformanceRecorder();
export function recordPerformance(event: PerformanceEvent): void {
	if (process.env.CROSS_SEED_PERFORMANCE_TELEMETRY === "1")
		performanceRecorder.record(event);
}
