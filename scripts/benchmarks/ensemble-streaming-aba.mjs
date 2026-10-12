import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpus, platform, arch, totalmem } from "node:os";
const [baseline, head, out] = process.argv
	.slice(2, 5)
	.map((value) => resolve(value));
assert.ok(
	!fs.existsSync(`${out}/samples.jsonl`),
	"Use a fresh output directory; preserve interrupted captures separately",
);
fs.mkdirSync(out, { recursive: true });
const smoke = process.argv.includes("--smoke");
const rounds = smoke ? 1 : 5;
const fixtures = [];
for (const count of [0, 1, 100, 8194, 20000, 30000])
	for (const aliases of [1, 2, 5])
		fixtures.push({ count, aliases, files: 1, delay: 0 });
fixtures.push(
	{ count: 100, aliases: 2, files: 1000, delay: 0 },
	{ count: 1, aliases: 5, files: 10000, delay: 0 },
	{ count: 100, aliases: 2, files: 1, delay: 5 },
);
fixtures.push({ count: 100, aliases: 2, files: 1, delay: 0, sourceDelay: 5 });
for (const count of [0, 1, 100, 8194, 20000, 30000])
	fixtures.push({ count, aliases: 2, files: 1, delay: 0, mode: "index" });
if (smoke)
	fixtures.splice(
		0,
		fixtures.length,
		{ count: 100, aliases: 2, files: 1, delay: 0 },
		{ count: 100, aliases: 2, files: 1, delay: 0, sourceDelay: 5 },
		{ count: 100, aliases: 2, files: 1, delay: 0, mode: "index" },
	);
const identities = {};
const digestFile = (path) =>
	createHash("sha256").update(fs.readFileSync(path)).digest("hex");
fs.writeFileSync(
	`${out}/environment.json`,
	JSON.stringify(
		{
			node: process.version,
			platform: platform(),
			arch: arch(),
			cpuModel: cpus()[0].model,
			totalMemoryBytes: totalmem(),
			rounds,
			expectedWorkers: fixtures.length * rounds * 3,
			controllerSha256: digestFile(new URL(import.meta.url)),
			workerSha256: digestFile(
				new URL("./ensemble-streaming.mjs", import.meta.url),
			),
			baseline,
			head,
			identityNote:
				"Working source may precede its publication commit; each worker pins actual source/dist/lock hashes. Run alone; filesystem delays are synthetic.",
		},
		null,
		2,
	),
);
for (const fixture of fixtures)
	for (let round = 0; round < rounds; round++) {
		const records = [];
		for (const phase of ["A1", "B", "A2"]) {
			const checkout = phase === "B" ? head : baseline;
			let result;
			try {
				result = execFileSync(
					process.execPath,
					[
						new URL("./ensemble-streaming.mjs", import.meta.url)
							.pathname,
						checkout,
						String(fixture.count),
						String(fixture.aliases),
						String(fixture.delay),
						"1",
						fixture.mode ?? "refresh",
					],
					{
						env: {
							...process.env,
							BENCH_FILES: String(fixture.files),
							BENCH_SOURCE_DELAY: String(
								fixture.sourceDelay ?? 0,
							),
						},
						encoding: "utf8",
						maxBuffer: 32 * 1024 * 1024,
						timeout: 180_000,
					},
				);
			} catch (error) {
				fs.writeFileSync(
					`${out}/failed-${fixture.count}-${fixture.aliases}-${fixture.mode ?? "refresh"}-${round}-${phase}.log`,
					String(error.stdout ?? "") +
						String(error.stderr ?? "") +
						String(error),
				);
				throw error;
			}
			const line = result
				.split("\n")
				.find((line) => line.startsWith("BENCH_RESULT "));
			assert.ok(line, result.slice(-1000));
			const data = JSON.parse(line.slice(13));
			const identity = JSON.stringify(data.sourceIdentities);
			const key = phase === "B" ? "head" : "baseline";
			identities[key] ??= identity;
			assert.equal(identity, identities[key], "source drift");
			assert.equal(data.refresh.searchees, fixture.count);
			assert.equal(data.sql.parsedAliasCount, fixture.aliases);
			assert.equal(
				data.sql.writtenMembershipRows,
				fixture.count * fixture.aliases,
			);
			assert.equal(data.node, process.version);
			assert.equal(
				data.remainingEnsemble,
				fixture.count,
				"named-host aliases retain baseline last-winner semantics",
			);
			const record = { fixture, round, phase, ...data };
			records.push(record);
			fs.appendFileSync(
				`${out}/samples.jsonl`,
				JSON.stringify(record) + "\n",
			);
		}
		assert.equal(records[0].membershipDigest, records[1].membershipDigest);
		assert.equal(records[2].membershipDigest, records[1].membershipDigest);
		console.log(
			JSON.stringify({
				fixture,
				round,
				wall: records.map((x) => x.wallMs.p50),
			}),
		);
	}
fs.writeFileSync(
	`${out}/complete.json`,
	JSON.stringify(
		{ success: true, workers: fixtures.length * rounds * 3, identities },
		null,
		2,
	),
);
