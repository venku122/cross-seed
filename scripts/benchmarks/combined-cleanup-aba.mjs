import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpus, arch, platform, totalmem } from "node:os";
const [baseline, candidate, destination] = process.argv
	.slice(2)
	.map((value) => resolve(value));
assert.ok(
	!fs.existsSync(join(destination, "samples.jsonl")),
	"Use a fresh output directory; preserve previous captures",
);
fs.mkdirSync(destination, { recursive: true });
const worker = fileURLToPath(
	new URL("./combined-cleanup.mjs", import.meta.url),
);
const expected = {};
const digestFile = (path) =>
	createHash("sha256").update(fs.readFileSync(path)).digest("hex");
fs.writeFileSync(
	join(destination, "environment.json"),
	JSON.stringify(
		{
			node: process.version,
			platform: platform(),
			arch: arch(),
			cpuModel: cpus()[0].model,
			totalMemoryBytes: totalmem(),
			baseline,
			candidate,
			expectedWorkers: 60,
			rounds: 5,
			controllerSha256: digestFile(new URL(import.meta.url)),
			workerSha256: digestFile(worker),
			scope: "Local synthetic compiled qB full cleanup; run exclusively; no NFS/ZFS or production invocation weighting",
		},
		null,
		2,
	),
);
let completed = 0;
for (const count of [8194, 30000]) {
	for (const aliases of [1, 5]) {
		for (let round = 0; round < 5; round++) {
			const records = [];
			for (const phase of ["A1", "B", "A2"]) {
				const checkout = phase === "B" ? candidate : baseline;
				const id = `${count}-${aliases}-${round}-${phase}`;
				const run = spawnSync(
					process.execPath,
					[
						worker,
						checkout,
						String(count),
						String(aliases),
						"0",
						"1",
						"refresh",
					],
					{
						encoding: "utf8",
						maxBuffer: 32 * 1024 * 1024,
						timeout: 180_000,
						env: {
							...process.env,
							BENCH_FILES: "50",
							BENCH_CLIENTS: "1",
							BENCH_SOURCE_DELAY: "0",
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
					`${id} failed; raw log preserved (${run.error?.message ?? run.signal ?? "nonzero exit"})`,
				);
				const line = run.stdout
					.split("\n")
					.find((line) => line.startsWith("BENCH_RESULT "));
				assert.ok(line, `${id} omitted result`);
				const result = JSON.parse(line.slice(13));
				const key = phase === "B" ? "candidate" : "baseline";
				const identity = JSON.stringify({
					source: result.sourceIdentities,
					lock: result.lockSha256,
					worker: result.workerSha256,
				});
				expected[key] ??= identity;
				assert.equal(
					identity,
					expected[key],
					"Source/dist/lock changed during matrix",
				);
				assert.equal(result.refresh.calls, 1);
				assert.equal(result.refresh.searchees, count);
				assert.equal(result.cacheRows, count);
				assert.equal(result.remainingData, count);
				assert.equal(result.remainingEnsemble, count);
				assert.equal(result.generation.generatedSources, count);
				assert.equal(result.generation.generatedRows, count * aliases);
				assert.equal(result.http.errors, 0);
				assert.deepEqual(result.integrity, [{ integrity_check: "ok" }]);
				const record = {
					id,
					phase,
					round,
					fixture: { count, aliases, files: 50 },
					result,
				};
				records.push(record);
				fs.appendFileSync(
					join(destination, "samples.jsonl"),
					JSON.stringify(record) + "\n",
				);
				completed++;
				console.log(
					`${completed}/60 ${id} ${result.wallMs.p50.toFixed(2)} ms SQL=${result.sql.calls} cacheJSONread=${result.adapter.fileJsonReadBytes}`,
				);
			}
			for (const field of [
				"membershipDigest",
				"cacheRowDigest",
				"dataRowDigest",
				"cacheFileJsonBytes",
				"lockSha256",
			]) {
				assert.equal(
					records[0].result[field],
					records[1].result[field],
					`${field} differs A1/B`,
				);
				assert.equal(
					records[2].result[field],
					records[1].result[field],
					`${field} differs A2/B`,
				);
			}
		}
	}
}
fs.writeFileSync(
	join(destination, "complete.json"),
	JSON.stringify({ success: true, workers: completed, expected }, null, 2),
);
