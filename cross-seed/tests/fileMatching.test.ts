import { beforeEach, describe, expect, it, vi } from "vitest";

await vi.hoisted(async () => {
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	process.env.CONFIG_DIR = mkdtempSync(join(tmpdir(), "matching-tests-"));
});
import {
	assessCandidate,
	compareFileTrees,
	compareFileTreesIgnoringNames,
	compareFileTreesPartial,
	getPartialSizeRatio,
} from "../src/decide.js";
import { getDefaultRuntimeConfig } from "../src/configuration.js";
import { Metafile } from "../src/parseTorrent.js";
import { setRuntimeConfig } from "../src/runtimeConfig.js";
import { Decision, MatchMode } from "../src/constants.js";
import { Label } from "../src/logger.js";
import type { File } from "../src/searchee.js";
import { fileFactory } from "./factories/file.js";
import { searcheeFactory } from "./factories/searchee.js";

function candidate(files: File[], length = 100, pieceLength = 10) {
	const meta = new Metafile({
		info: {
			name: Buffer.from("synthetic"),
			length,
			"piece length": pieceLength,
			pieces: Buffer.alloc(20),
			private: 0,
		},
	});
	meta.files = files;
	return meta;
}

// Padding exercises both the array path and the large-release index path.
function padding(count: number): File[] {
	return Array.from({ length: count }, (_, i) =>
		fileFactory({
			name: `pad-${i}`,
			path: `root/pad-${i}`,
			length: 1000 + i,
		}),
	);
}

describe("file matching", () => {
	beforeEach(() => setRuntimeConfig(getDefaultRuntimeConfig()));

	for (const count of [0, 160]) {
		describe(`with ${count} padding files`, () => {
			it("matches subsets without consuming exact membership", () => {
				const file = fileFactory({ length: 10 });
				const meta = candidate([file, file, ...padding(count)]);
				const source = searcheeFactory({
					files: [file, ...padding(count)],
				});
				expect(compareFileTrees(meta, source)).toBe(true);
				expect(compareFileTreesIgnoringNames(meta, source)).toBe(false);
			});

			it("uses names for virtual sources and paths for client or data sources", () => {
				const file = fileFactory({ length: 10 });
				const meta = candidate([file, ...padding(count)]);
				const source = searcheeFactory({
					files: [
						{ ...file, path: "another/root" },
						...padding(count),
					],
				});
				expect(compareFileTrees(meta, source)).toBe(true);
				expect(
					compareFileTrees(meta, { ...source, path: "/synthetic" }),
				).toBe(false);
				expect(
					compareFileTrees(meta, {
						...source,
						infoHash: "synthetic",
					}),
				).toBe(false);
			});

			it("requires names for tied sizes, then allows a different name for the last size", () => {
				const a = fileFactory({ name: "a", length: 10 });
				const b = fileFactory({ name: "b", length: 10 });
				const c = fileFactory({ name: "c", length: 10 });
				const source = searcheeFactory({
					files: [a, b, ...padding(count)],
				});
				expect(
					compareFileTreesIgnoringNames(
						candidate([c, a, ...padding(count)]),
						source,
					),
				).toBe(false);
				expect(
					compareFileTreesIgnoringNames(
						candidate([a, c, ...padding(count)]),
						source,
					),
				).toBe(true);
			});

			it("consumes duplicate names individually", () => {
				const a = fileFactory({ name: "a", length: 10 });
				const b = fileFactory({ name: "b", length: 10 });
				const source = searcheeFactory({
					files: [a, a, b, ...padding(count)],
				});
				expect(
					compareFileTreesIgnoringNames(
						candidate([a, a, a, ...padding(count)]),
						source,
					),
				).toBe(true);
				expect(
					compareFileTreesIgnoringNames(
						candidate([a, a, a, a, ...padding(count)]),
						source,
					),
				).toBe(false);
			});

			it("never matches NaN but matches signed zero and Infinity", () => {
				for (const length of [NaN, -0, Infinity]) {
					const file = fileFactory({ length });
					const source = searcheeFactory({
						files: [file, ...padding(count)],
					});
					const meta = candidate([
						{ ...file, length: Object.is(length, -0) ? 0 : length },
						...padding(count),
					]);
					expect(compareFileTrees(meta, source)).toBe(
						!Number.isNaN(length),
					);
					expect(compareFileTreesIgnoringNames(meta, source)).toBe(
						!Number.isNaN(length),
					);
				}
			});

			it("rounds partial progress down to whole pieces", () => {
				const pads = padding(count).map((file) => ({
					...file,
					length: 0,
				}));
				const file = fileFactory({ length: 95 });
				const meta = candidate([file, ...pads]);
				const source = searcheeFactory({
					files: [file, ...pads],
					path: "/synthetic",
				});
				setRuntimeConfig({
					...getDefaultRuntimeConfig(),
					fuzzySizeThreshold: 0.05,
				});
				expect(getPartialSizeRatio(meta, source)).toBe(0.95);
				expect(compareFileTreesPartial(meta, source)).toBe(false);
				setRuntimeConfig({
					...getDefaultRuntimeConfig(),
					fuzzySizeThreshold: 0.1,
				});
				expect(compareFileTreesPartial(meta, source)).toBe(true);
			});
		});
	}

	it("allows a missing small file only in partial mode", () => {
		const files = padding(159).map((file) => ({ ...file, length: 100 }));
		const missing = fileFactory({ name: "small.nfo", length: 1 });
		const meta = candidate([...files, missing], 15901, 100);
		const source = searcheeFactory({ files, path: "/synthetic" });
		setRuntimeConfig({
			...getDefaultRuntimeConfig(),
			fuzzySizeThreshold: 0.05,
		});
		expect(compareFileTrees(meta, source)).toBe(false);
		expect(compareFileTreesIgnoringNames(meta, source)).toBe(false);
		expect(getPartialSizeRatio(meta, source)).toBe(15900 / 15901);
		expect(compareFileTreesPartial(meta, source)).toBe(true);
	});

	it.each([
		["exact", compareFileTrees],
		["size-only", compareFileTreesIgnoringNames],
	])(
		"rejects an unavailable first size without building a full index (%s)",
		(_name, compare) => {
			const files = padding(200);
			let reads = 0;
			const source = searcheeFactory({
				files: files.map((file) => ({
					...file,
					get length() {
						reads++;
						return file.length;
					},
				})),
			});
			const meta = candidate([
				{ ...files[0], length: -1 },
				...files.slice(1),
			]);
			expect(compare(meta, source)).toBe(false);
			expect(reads).toBeLessThanOrEqual(files.length);
		},
	);

	it("reuses source indexing across partial assessment and resets consumption", async () => {
		const files = padding(200);
		let reads = 0;
		const source = {
			...searcheeFactory({
				files: files.map((file) => ({
					...file,
					get length() {
						reads++;
						return file.length;
					},
				})),
			}),
			label: Label.SEARCH as const,
			path: "/synthetic",
		};
		const meta = candidate(
			[{ ...files[0], length: 1 }, ...files.slice(1)],
			219901,
			1,
		);
		for (let i = 0; i < 2; i++) {
			reads = 0;
			const result = await assessCandidate(meta, source, new Set(), [], {
				configOverride: { matchMode: MatchMode.PARTIAL },
			});
			expect(result.decision).toBe(Decision.MATCH_PARTIAL);
			expect(reads).toBeLessThanOrEqual(3 * files.length);
		}
	});

	it("does not consume partial matches while rejecting the size-only pass", async () => {
		const files = padding(200);
		files[1] = { ...files[1], length: files[0].length };
		files[2] = { ...files[2], length: files[0].length };
		const candidateFiles = files.map((file, i) => ({
			...file,
			path: `other/${i}`,
		}));
		candidateFiles[1].name = "absent";
		const meta = candidate(candidateFiles, 219897, 1);
		const source = {
			...searcheeFactory({ files }),
			path: "/synthetic",
			label: Label.SEARCH as const,
		};
		const result = await assessCandidate(meta, source, new Set(), [], {
			configOverride: { matchMode: MatchMode.PARTIAL },
		});
		expect(result.decision).toBe(Decision.MATCH_PARTIAL);
	});

	it.each([MatchMode.STRICT, MatchMode.FLEXIBLE])(
		"rejects an absent first size in one assessment scan (%s)",
		async (matchMode) => {
			const files = padding(200);
			let reads = 0;
			const source = {
				...searcheeFactory({
					files: files.map((file) => ({
						...file,
						get length() {
							reads++;
							return file.length;
						},
					})),
				}),
				path: "/synthetic",
				label: Label.SEARCH as const,
			};
			const meta = candidate(
				[{ ...files[0], length: 1 }, ...files.slice(1)],
				218901,
				1,
			);
			const result = await assessCandidate(meta, source, new Set(), [], {
				configOverride: { matchMode },
			});
			expect(result.decision).toBe(Decision.SIZE_MISMATCH);
			expect(result.metafile).toBe(meta);
			expect(result.metaCached).toBe(true);
			expect(reads).toBeLessThanOrEqual(files.length);
		},
	);

	it.each([2, 8, 9, 160])(
		"preserves duplicate multiplicity for a %i-file size group",
		(count) => {
			const files = Array.from({ length: count }, (_, i) =>
				fileFactory({
					name: i % 2 ? "b" : "a",
					path: i % 2 ? "root/b" : "root/a",
					length: 10,
				}),
			);
			const pads = padding(160).map((file) => ({ ...file, length: 0 }));
			const source = searcheeFactory({
				files: [...files, ...pads],
				path: "/synthetic",
			});
			const meta = candidate(
				[...Array.from({ length: count }, () => files[0]), ...pads],
				count * 10,
				1,
			);
			expect(compareFileTrees(meta, source)).toBe(true);
			expect(compareFileTreesIgnoringNames(meta, source)).toBe(
				count === 2,
			);
			expect(compareFileTreesPartial(meta, source)).toBe(count === 2);
		},
	);

	it.each([8, 9])(
		"accepts a renamed last file after consuming a %i-file size group",
		(count) => {
			const files = Array.from({ length: count }, (_, i) =>
				fileFactory({
					name: `file-${i}`,
					path: `root/file-${i}`,
					length: 10,
				}),
			);
			const pads = padding(160).map((file) => ({ ...file, length: 0 }));
			const candidateFiles = files.map((file) => ({ ...file }));
			candidateFiles[count - 1] = {
				...candidateFiles[count - 1],
				name: "renamed",
				path: "other/renamed",
			};
			const source = searcheeFactory({
				files: [...files, ...pads],
				path: "/synthetic",
			});
			const meta = candidate([...candidateFiles, ...pads], count * 10, 1);
			expect(compareFileTrees(meta, source)).toBe(false);
			expect(compareFileTreesIgnoringNames(meta, source)).toBe(true);
			expect(compareFileTreesPartial(meta, source)).toBe(true);
		},
	);

	it("avoids quadratic file-size reads for a large successful comparison", () => {
		const files = padding(200);
		let reads = 0;
		const source = searcheeFactory({
			files: files.map((file) => ({
				...file,
				get length() {
					reads++;
					return file.length;
				},
			})),
		});
		const meta = candidate(files);
		for (const compare of [
			compareFileTrees,
			compareFileTreesIgnoringNames,
			getPartialSizeRatio,
			compareFileTreesPartial,
		]) {
			reads = 0;
			compare(meta, source);
			expect(reads).toBeLessThan(1000);
		}
	});
});
