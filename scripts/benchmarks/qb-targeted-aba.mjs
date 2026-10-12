import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	mkdirSync,
	existsSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
const [baseline, head, output] = process.argv.slice(2).map((p) => resolve(p));
if (!output)
	throw new Error("Usage: node qb-targeted-aba.mjs BASELINE HEAD OUTPUT");
mkdirSync(output, { recursive: true });
const worker = fileURLToPath(new URL("qb-targeted.mjs", import.meta.url));
const fixtures = [0, 1, 100, 8194, 20000, 30000].flatMap((count) =>
	(count < 2 ? [0] : [0, 1, 10]).map((modified) => ({
		count,
		modified,
		files: 1,
	})),
);
for (const count of [8194, 30000])
	for (const modified of [0, 1, 10])
		for (const files of [100, 1000, 10000])
			fixtures.push({ count, modified, files });
const samplePath = join(output, "samples.jsonl");
const previous = existsSync(samplePath)
	? readFileSync(samplePath, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line))
	: [];
if (previous.length && !process.argv.includes("--resume"))
	throw new Error(
		"Output already contains samples; use a fresh directory or --resume",
	);
const completed = Math.floor(previous.length / 3) * 3;
const schedule = fixtures
	.flatMap((fixture) =>
		Array.from({ length: 5 }, (_, round) =>
			["A1", "B", "A2"].map((phase) => ({ fixture, round, phase })),
		),
	)
	.flat();
if (previous.length > schedule.length)
	throw new Error("Too many existing samples");
for (let i = 0; i < completed; i++)
	if (
		JSON.stringify(previous[i].fixture) !==
			JSON.stringify(schedule[i].fixture) ||
		previous[i].round !== schedule[i].round ||
		previous[i].phase !== schedule[i].phase
	)
		throw new Error("Existing sample schedule mismatch");
if (previous.length !== completed) {
	writeFileSync(
		join(output, "interrupted-partial-samples.jsonl"),
		previous.map((s) => JSON.stringify(s)).join("\n") + "\n",
	);
	writeFileSync(
		samplePath,
		previous
			.slice(0, completed)
			.map((s) => JSON.stringify(s))
			.join("\n") + "\n",
	);
}
let ordinal = 0;
for (const fixture of fixtures)
	for (let round = 0; round < 5; round++)
		for (const [phase, repo, mode] of [
			["A1", baseline, "baseline"],
			["B", head, "targeted"],
			["A2", baseline, "baseline"],
		]) {
			if (ordinal++ < completed) continue;
			const child = spawnSync(process.execPath, [worker, repo], {
				encoding: "utf8",
				env: {
					...process.env,
					QB_COUNT: String(fixture.count),
					QB_MODIFIED: String(fixture.modified),
					QB_FILES: String(fixture.files),
					QB_MODE: mode,
				},
				maxBuffer: 1024 * 1024 * 10,
			});
			if (child.status !== 0)
				throw new Error(
					`${JSON.stringify({ fixture, round, phase })}: ${child.stderr}\n${child.stdout}`,
				);
			const result = JSON.parse(child.stdout.trim());
			appendFileSync(
				join(output, "samples.jsonl"),
				JSON.stringify({ fixture, round, phase, ...result }) + "\n",
			);
		}
writeFileSync(
	join(output, "complete.json"),
	JSON.stringify({
		success: true,
		samples: fixtures.length * 15,
		completedTripletsReused: completed / 3,
	}) + "\n",
);
console.log(
	JSON.stringify({
		fixtures: fixtures.length,
		samples: fixtures.length * 15,
		output,
	}),
);
