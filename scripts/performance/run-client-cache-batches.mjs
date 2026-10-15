import { spawnSync } from "node:child_process";
import {
	mkdir,
	writeFile,
	appendFile,
	readdir,
	readFile,
} from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import os from "node:os";
const [baselineArg, candidateArg, resultsArg] = process.argv.slice(2);
if (!resultsArg)
	throw new Error(
		"usage: node run-client-cache-batches.mjs baseline candidate external-results-dir",
	);
const baseline = resolve(baselineArg),
	candidate = resolve(candidateArg),
	results = resolve(resultsArg);
await mkdir(results, { recursive: true });
const harness = join(
	dirname(fileURLToPath(import.meta.url)),
	"client-cache-batches.mjs",
);
const command = (cmd, args, cwd) => {
	const p = spawnSync(cmd, args, { cwd, encoding: "utf8" });
	if (p.status) throw new Error(`${cmd}: ${p.stderr}`);
	return p.stdout.trim();
};
async function digestDirectory(root) {
	const hash = createHash("sha256");
	for (const path of (await readdir(root)).toSorted()) {
		if (!path.endsWith(".ts") && !path.endsWith(".js")) continue;
		hash.update(path);
		hash.update(await readFile(join(root, path)));
	}
	const ext = root.includes("/dist/") ? ".js" : ".ts";
	for (const stem of ["searchee", "db", "utils"]) {
		hash.update(stem);
		hash.update(await readFile(join(dirname(root), stem + ext)));
	}
	return hash.digest("hex");
}
const metadata = {
	node: process.version,
	platform: process.platform,
	arch: process.arch,
	cpus: os.cpus().map((c) => c.model),
	nodeBinary: process.execPath,
	runnerSha256: createHash("sha256")
		.update(await readFile(fileURLToPath(import.meta.url)))
		.digest("hex"),
	harnessSha256: createHash("sha256")
		.update(await readFile(harness))
		.digest("hex"),
	baseline: {
		path: baseline,
		head: command("git", ["rev-parse", "HEAD"], baseline),
		sourceSha256: await digestDirectory(
			join(baseline, "cross-seed/src/clients"),
		),
		compiledSha256: await digestDirectory(
			join(baseline, "cross-seed/dist/clients"),
		),
	},
	candidate: {
		path: candidate,
		head: command("git", ["rev-parse", "HEAD"], candidate),
		sourceSha256: await digestDirectory(
			join(candidate, "cross-seed/src/clients"),
		),
		compiledSha256: await digestDirectory(
			join(candidate, "cross-seed/dist/clients"),
		),
		diffSha256: createHash("sha256")
			.update(command("git", ["diff"], candidate))
			.digest("hex"),
	},
};
const metadataPath = join(results, "metadata.json");
try {
	await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + "\n", {
		flag: "wx",
	});
} catch (error) {
	if (error.code !== "EEXIST") throw error;
	const previous = JSON.parse(await readFile(metadataPath, "utf8"));
	if (JSON.stringify(previous) !== JSON.stringify(metadata))
		throw new Error(
			"Frozen source, compiled files, runtime or harness changed; use a new results directory",
		);
}
await writeFile(
	join(results, "runner-state.json"),
	JSON.stringify({
		pid: process.pid,
		status: "running",
		startedAt: new Date().toISOString(),
	}),
);
const clients = ["QBittorrent", "Transmission", "Deluge", "RTorrent"];
const cases = clients.flatMap((client) => [
	{
		client,
		count: 100,
		scenario: "unchanged",
		files: 100,
		warmth: "cold-ish",
	},
	{
		client,
		count: 100,
		scenario: "new-only",
		files: 1000,
		warmth: "cold-ish",
	},
	{
		client,
		count: 1,
		scenario: "new-only",
		files: 10000,
		warmth: "cold-ish",
	},
	...[0, 1, 100, 8194, 20000, 30000].map((count) => ({
		client,
		count,
		scenario: "unchanged",
		files: 4,
		warmth: "cold-ish",
	})),
	...["changed1", "changed10", "force-all", "new-only"].map((scenario) => ({
		client,
		count: 8194,
		scenario,
		files: 4,
		warmth: "cold-ish",
	})),
	{ client, count: 8194, scenario: "unchanged", files: 4, warmth: "warm" },
	{
		client,
		count: 100,
		scenario: "unchanged",
		files: 1000,
		warmth: "cold-ish",
	},
	{
		client,
		count: 1,
		scenario: "unchanged",
		files: 10000,
		warmth: "cold-ish",
	},
]);
const rawPath = join(results, "aba.jsonl");
await appendFile(rawPath, "");
const previousRows = (await readFile(rawPath, "utf8"))
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line));
function verifyTriplet(triplet, fixture) {
	for (const key of [
		"outputDigest",
		"rowsDigest",
		"requests",
		"bytes",
		"outputCount",
		"outputFiles",
		"newCount",
		"filesJsonParses",
	])
		if (triplet.some((row) => row[key] !== triplet[0][key]))
			throw new Error(
				`semantic mismatch ${key}: ${JSON.stringify(fixture)}`,
			);
}
for (let round = 1; round <= 5; round++) {
	for (const fixture of cases) {
		const previous = previousRows
			.filter(
				(row) =>
					row.round === round &&
					row.clientName === fixture.client &&
					row.count === fixture.count &&
					row.scenario === fixture.scenario &&
					row.fileCount === fixture.files &&
					row.warmth === fixture.warmth,
			)
			.slice(-3);
		if (
			previous.length === 3 &&
			previous.map((row) => row.phase).join(",") === "A1,B,A2"
		) {
			verifyTriplet(previous, fixture);
			continue;
		}
		const triplet = [];
		for (const [phase, repo] of [
			["A1", baseline],
			["B", candidate],
			["A2", baseline],
		]) {
			const args = [
				harness,
				repo,
				fixture.client,
				String(fixture.count),
				fixture.scenario,
				String(fixture.files),
				phase === "B" ? "assert-batched" : "",
				fixture.warmth,
			];
			const p = spawnSync(process.execPath, args, {
				encoding: "utf8",
				maxBuffer: 8 * 1024 * 1024,
			});
			if (p.status !== 0) {
				await writeFile(
					join(
						results,
						`failure-${round}-${fixture.client}-${fixture.count}-${fixture.scenario}-${phase}.log`,
					),
					p.stdout + p.stderr,
				);
				throw new Error(`failed ${JSON.stringify(fixture)} ${phase}`);
			}
			const record = JSON.parse(
				p.stdout
					.split("\n")
					.findLast((line) => line.startsWith('{"clientName"')),
			);
			const result = { round, phase, ...record };
			triplet.push(result);
			await appendFile(rawPath, JSON.stringify(result) + "\n");
		}
		verifyTriplet(triplet, fixture);
	}
	console.log(
		`Completed round ${round}/5 (${cases.length} A/B/A fixture triplets)`,
	);
}
await writeFile(
	join(results, "runner-state.json"),
	JSON.stringify({
		pid: process.pid,
		status: "complete",
		finishedAt: new Date().toISOString(),
		triplets: cases.length * 5,
		rawSha256: createHash("sha256")
			.update(await readFile(rawPath))
			.digest("hex"),
	}),
);
console.log(rawPath);
