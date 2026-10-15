import { fileURLToPath } from "node:url";
// Tiny correctness smoke only; no cross-platform performance inference.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
const [baseline, candidate, destination] = process.argv
	.slice(2)
	.map((value) => resolve(value));
fs.mkdirSync(destination, { recursive: true });
for (const aliases of [1, 5]) {
	const results = [];
	for (const [phase, checkout] of [
		["baseline", baseline],
		["candidate", candidate],
	]) {
		const id = `${phase}-aliases-${aliases}`;
		const run = spawnSync(
			process.execPath,
			[
				fileURLToPath(
					new URL("./combined-cleanup.mjs", import.meta.url),
				),
				checkout,
				"3",
				String(aliases),
				"0",
				"1",
				"refresh",
			],
			{
				encoding: "utf8",
				maxBuffer: 8 * 1024 * 1024,
				timeout: 60000,
				env: {
					...process.env,
					BENCH_FILES: "50",
					BENCH_CLIENTS: "1",
					BENCH_SOURCE_DELAY: "0",
					BENCH_GIT_SHA:
						phase === "baseline"
							? process.env.BENCH_BASELINE_SHA
							: process.env.BENCH_CANDIDATE_SHA,
				},
			},
		);
		fs.writeFileSync(
			join(destination, `${id}.log`),
			(run.stdout ?? "") + (run.stderr ?? ""),
		);
		assert.equal(
			run.status,
			0,
			`${id} failed: ${run.error?.message ?? run.signal ?? "nonzero exit"}`,
		);
		const line = run.stdout
			.split("\n")
			.find((line) => line.startsWith("BENCH_RESULT "));
		assert.ok(line, `${id} omitted result`);
		const result = JSON.parse(line.slice(13));
		assert.equal(result.cacheRows, 3);
		assert.equal(result.remainingData, 3);
		assert.equal(result.remainingEnsemble, 3);
		assert.equal(result.generation.generatedRows, 3 * aliases);
		assert.equal(result.http.errors, 0);
		results.push(result);
		fs.writeFileSync(
			join(destination, `${id}.json`),
			JSON.stringify(result, null, 2),
		);
	}
	for (const field of [
		"membershipDigest",
		"cacheRowDigest",
		"dataRowDigest",
		"cacheFileJsonBytes",
		"lockSha256",
	])
		assert.equal(
			results[0][field],
			results[1][field],
			`${field} baseline/candidate differs`,
		);
}
fs.writeFileSync(
	join(destination, "complete.json"),
	JSON.stringify(
		{
			success: true,
			workers: 4,
			scope: "tiny structural correctness only",
			node: process.version,
			platform: process.platform,
			arch: process.arch,
		},
		null,
		2,
	),
);
console.log("Four platform structural workers passed; no performance claim.");
