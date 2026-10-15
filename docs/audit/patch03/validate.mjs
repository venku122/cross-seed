import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const helpers = [
	"compareFileTrees",
	"compareFileTreesIgnoringNames",
	"getPartialSizeRatio",
	"compareFileTreesPartial",
];
export async function load(root) {
	root = resolve(root);
	const config = await mkdtemp(join(tmpdir(), "matching-compiled-"));
	process.env.CONFIG_DIR = config;
	const modulePath = resolve(root, "cross-seed/dist/decide.js");
	const url = (name) =>
		pathToFileURL(resolve(root, `cross-seed/dist/${name}.js`)).href;
	const configuration = await import(url("configuration"));
	const runtime = await import(url("runtimeConfig"));
	runtime.setRuntimeConfig(configuration.getDefaultRuntimeConfig());
	const implementation = await import(pathToFileURL(modulePath).href);
	const { db } = await import(url("db"));
	const { Metafile } = await import(url("parseTorrent"));
	return {
		implementation,
		Metafile,
		setConfig: (values) =>
			runtime.setRuntimeConfig({
				...configuration.getDefaultRuntimeConfig(),
				...values,
			}),
		identity: {
			commit:
				process.env.BENCH_GIT_SHA ??
				execFileSync("git", ["rev-parse", "HEAD"], {
					cwd: root,
					encoding: "utf8",
				}).trim(),
			sourceSha256: createHash("sha256")
				.update(
					await readFile(resolve(root, "cross-seed/src/decide.ts")),
				)
				.digest("hex"),
			compiledSha256: createHash("sha256")
				.update(await readFile(modulePath))
				.digest("hex"),
			lockSha256: createHash("sha256")
				.update(await readFile(resolve(root, "package-lock.json")))
				.digest("hex"),
			module: "cross-seed/dist/decide.js",
		},
		close: async () => {
			await db.destroy();
			await rm(config, { recursive: true, force: true });
		},
	};
}
function random(seed) {
	let state = seed >>> 0;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 2 ** 32;
	};
}
function file(rng, index) {
	const edges = [NaN, 0, -0, Infinity, -Infinity, 1, 9, 10, 11];
	return {
		name: `file-${Math.floor(rng() * 12)}.mkv`,
		path: `root-${Math.floor(rng() * 3)}/file-${index % 17}.mkv`,
		length:
			rng() < 0.08
				? edges[Math.floor(rng() * edges.length)]
				: Math.floor(rng() * 50),
	};
}
export function fixture(count, outcome, distribution = "unique") {
	const files = Array.from({ length: count }, (_, i) => ({
		name: `file-${i}.mkv`,
		path: `release/file-${i}.mkv`,
		length: 1024 + (distribution === "tied" ? Math.floor(i / 2) : i),
	}));
	const candidateFiles = files.map((f) => ({ ...f }));
	if (outcome !== "success")
		candidateFiles[outcome === "first-failure" ? 0 : count - 1].length =
			999999;
	return [
		{
			files: candidateFiles,
			length: candidateFiles.reduce((s, f) => s + f.length, 0),
			pieceLength: 16,
		},
		{
			files,
			length: files.reduce((s, f) => s + f.length, 0),
			name: "release",
			title: "release",
			path: "/synthetic/release",
		},
	];
}

async function main() {
	const [baselinePath, candidatePath] = process.argv.slice(2);
	assert(
		baselinePath && candidatePath,
		"Usage: node validate.mjs BASELINE_WORKTREE CANDIDATE_WORKTREE",
	);
	const baseline = await load(baselinePath);
	const candidate = await load(candidatePath);
	let checks = 0;
	const seeds = [0xdecafbad, 0x12345678, 0x5eed2026];
	try {
		for (const seed of seeds) {
			const rng = random(seed);
			const counts = [0, 1, 20, 31, 32, 33, 100, 127, 128, 129, 200];
			for (let iteration = 0; iteration < 10000; iteration++) {
				const count = counts[iteration % counts.length];
				const sourceFiles = Array.from({ length: count }, (_, i) =>
					file(rng, i),
				);
				const candidateFiles = sourceFiles.map((f) => ({ ...f }));
				// Include exact successes, permutations, mismatches, subsets and extra duplicates.
				if (iteration % 6 === 1) candidateFiles.reverse();
				if (iteration % 6 === 2 && count)
					candidateFiles[Math.floor(rng() * count)] = file(
						rng,
						count + 1,
					);
				if (iteration % 6 === 3)
					candidateFiles.splice(Math.floor(rng() * (count + 1)));
				if (iteration % 6 === 4 && count)
					candidateFiles.push({ ...candidateFiles[0] });
				if (iteration % 6 === 5)
					for (const f of candidateFiles)
						f.name = `renamed-${Math.floor(rng() * 12)}`;
				const meta = {
					files: candidateFiles,
					length:
						iteration % 13 === 0
							? 0
							: candidateFiles.reduce(
									(sum, f) => sum + f.length,
									0,
								),
					pieceLength: [1, 10, 16, 64][iteration % 4],
				};
				const source = {
					files: sourceFiles,
					name: "synthetic",
					title: "synthetic",
					length: 10000,
					...(iteration % 3 === 0
						? {}
						: iteration % 3 === 1
							? { path: "/synthetic" }
							: { infoHash: "synthetic" }),
				};
				const config = {
					fuzzySizeThreshold: [0.01, 0.05, 0.1, 0.5][iteration % 4],
					seasonFromEpisodes: [false, 0.8, 0.95][iteration % 3],
				};
				baseline.setConfig(config);
				candidate.setConfig(config);
				for (const name of helpers) {
					const oldResult = baseline.implementation[name](
						meta,
						source,
					);
					const newResult = candidate.implementation[name](
						meta,
						source,
					);
					assert(
						Object.is(oldResult, newResult),
						`${name}: seed ${seed} iteration ${iteration}`,
					);
					checks++;
				}
			}
		}
		for (const distribution of ["unique", "tied"])
			for (const count of [1, 20, 100, 1000, 10000])
				for (const outcome of [
					"success",
					"first-failure",
					"last-failure",
				]) {
					const args = fixture(count, outcome, distribution);
					for (const name of helpers) {
						assert(
							Object.is(
								baseline.implementation[name](...args),
								candidate.implementation[name](...args),
							),
							`${name} ${count} ${outcome}`,
						);
						checks++;
					}
				}
		let assessmentChecks = 0;
		const assessmentCoverage = { randomized: {}, finite: {} };
		const recordCoverage = (kind, mode, count, decision) => {
			const band =
				count < 128 ? "below128" : count === 128 ? "at128" : "above128";
			const key = `${mode}/${band}/${decision}`;
			assessmentCoverage[kind][key] =
				(assessmentCoverage[kind][key] ?? 0) + 1;
		};
		for (const seed of seeds) {
			const rng = random(seed);
			for (let iteration = 0; iteration < 500; iteration++) {
				const count = [20, 127, 128, 129, 160][iteration % 5];
				const files = Array.from({ length: count }, (_, i) =>
					file(rng, i),
				);
				const candidates = files.map((f) => ({ ...f })).reverse();
				if (iteration % 3 === 0) candidates[0] = file(rng, count);
				if (iteration % 3 === 1)
					for (const f of candidates) f.path = `other/${f.path}`;
				const source = {
					files,
					name: "synthetic",
					title: "synthetic",
					label: "search",
					length: 10000,
					...(iteration % 3 === 0
						? {}
						: iteration % 3 === 1
							? { path: "/synthetic" }
							: { infoHash: "synthetic" }),
				};
				const config = {
					fuzzySizeThreshold: [0.02, 0.1, 0.5][iteration % 3],
					seasonFromEpisodes: false,
				};
				baseline.setConfig(config);
				candidate.setConfig(config);
				for (const mode of ["strict", "flexible", "partial"]) {
					const results = [];
					for (const runtime of [baseline, candidate]) {
						const meta = new runtime.Metafile({
							info: {
								name: Buffer.from("synthetic"),
								length: 1,
								"piece length": 16,
								pieces: Buffer.alloc(20),
								private: 0,
							},
						});
						meta.files = candidates;
						meta.length = candidates.reduce(
							(sum, f) => sum + f.length,
							0,
						);
						const result =
							await runtime.implementation.assessCandidate(
								meta,
								source,
								new Set(),
								[],
								{ configOverride: { matchMode: mode } },
							);
						results.push({
							decision: result.decision,
							metaCached: result.metaCached,
							originalMetafile: result.metafile === meta,
							keys: Object.keys(result).sort(),
						});
					}
					assert.deepEqual(
						results[0],
						results[1],
						`assessment ${seed}/${iteration}/${mode}`,
					);
					recordCoverage(
						"randomized",
						mode,
						count,
						results[0].decision,
					);
					assessmentChecks++;
				}
			}
		}

		let finiteAssessmentChecks = 0;
		for (const count of [1, 20, 127, 128, 129, 1000])
			for (const distribution of ["unique", "tied"])
				for (const outcome of ["exact", "renamed", "partial", "reject"])
					for (const mode of ["strict", "flexible", "partial"]) {
						const [data, source] = fixture(
							count,
							"success",
							distribution,
						);
						if (outcome === "renamed")
							for (const f of data.files)
								f.path = `other/${f.name}`;
						if (outcome === "partial") data.files[0].length = 1;
						if (outcome === "reject") data.files[0].length = 999999;
						data.length = data.files.reduce(
							(sum, f) => sum + f.length,
							0,
						);
						const expected =
							outcome === "exact"
								? "MATCH"
								: outcome === "renamed"
									? mode === "strict"
										? "FILE_TREE_MISMATCH"
										: "MATCH_SIZE_ONLY"
									: mode !== "partial"
										? "SIZE_MISMATCH"
										: outcome === "partial" && count > 1
											? "MATCH_PARTIAL"
											: "PARTIAL_SIZE_MISMATCH";
						const results = [];
						for (const runtime of [baseline, candidate]) {
							runtime.setConfig({
								fuzzySizeThreshold: 0.02,
								seasonFromEpisodes: 1,
							});
							const meta = new runtime.Metafile({
								info: {
									name: Buffer.from("synthetic"),
									length: data.length,
									"piece length": 16,
									pieces: Buffer.alloc(20),
									private: 0,
								},
							});
							meta.files = data.files;
							const result =
								await runtime.implementation.assessCandidate(
									meta,
									{ ...source, label: "search" },
									new Set(),
									[],
									{ configOverride: { matchMode: mode } },
								);
							assert.equal(
								result.decision,
								expected,
								`finite ${count}/${distribution}/${outcome}/${mode}`,
							);
							results.push({
								decision: result.decision,
								metaCached: result.metaCached,
								originalMetafile: result.metafile === meta,
								keys: Object.keys(result).sort(),
							});
						}
						assert.deepEqual(results[0], results[1]);
						recordCoverage("finite", mode, count, expected);
						assessmentChecks++;
						finiteAssessmentChecks++;
					}

		console.log(
			JSON.stringify(
				{
					node: process.version,
					seeds,
					checks,
					assessmentChecks,
					finiteAssessmentChecks,
					assessmentCoverage,
					baseline: baseline.identity,
					candidate: candidate.identity,
					outcome: "zero mismatches",
				},
				null,
				2,
			),
		);
	} finally {
		await baseline.close();
		await candidate.close();
	}
}
if (
	process.argv[1] &&
	resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)
)
	await main();
