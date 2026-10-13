import { describe, expect, it } from "vitest";
import {
	PerformanceRecorder,
	fileCountBucket,
} from "../src/performanceTelemetry.js";

describe("aggregate performance telemetry", () => {
	it("records fixed workload buckets and never arbitrary source metadata", () => {
		const recorder = new PerformanceRecorder();
		recorder.record({
			operation: "candidate",
			durationMs: 4,
			fileCount: 72,
			cache: "hit",
			rpcBytes: 401,
			sqlQueries: 2,
			ensembleRows: 24,
		});
		const sample = JSON.parse(
			JSON.stringify(recorder.snapshot()),
		) as ReturnType<PerformanceRecorder["snapshot"]>;
		expect(sample.candidate.count).toBe(1);
		expect(sample.candidate.fileCounts["25-100"]).toBe(1);
		expect(sample.candidate.cache.hit).toBe(1);
		expect(sample.candidate.rpcBytes).toBe(401);
		expect(JSON.stringify(sample)).not.toMatch(
			/name|hash|tracker|path|url/i,
		);
	});
	it("rejects unknown dimensions and nonfinite or negative counters", () => {
		const recorder = new PerformanceRecorder();
		expect(() =>
			recorder.record({
				operation: "private-name" as never,
				durationMs: 1,
			}),
		).toThrow();
		expect(() =>
			recorder.record({ operation: "candidate", durationMs: NaN }),
		).toThrow();
		expect(() =>
			recorder.record({
				operation: "candidate",
				durationMs: 1,
				rpcBytes: -1,
			}),
		).toThrow();
		expect(() =>
			recorder.record({
				operation: "candidate",
				durationMs: 1,
				cache: "secret-path" as never,
			}),
		).toThrow();
		expect(recorder.snapshot().candidate.count).toBe(0);
	});
	it("uses fixed buckets without retaining per-candidate samples", () => {
		const recorder = new PerformanceRecorder();
		for (let i = 0; i < 10000; i++)
			recorder.record({
				operation: "candidate",
				durationMs: 2,
				fileCount: i,
			});
		expect(recorder.snapshot().candidate.count).toBe(10000);
		expect(JSON.stringify(recorder.snapshot()).length).toBeLessThan(5000);
		expect(
			[0, 1, 2, 24, 25, 100, 101, 1000, 1001, 10000, 10001].map(
				fileCountBucket,
			),
		).toEqual([
			"0",
			"1",
			"2-24",
			"2-24",
			"25-100",
			"25-100",
			"101-1000",
			"101-1000",
			"1001-10000",
			"1001-10000",
			">10000",
		]);
	});
});
