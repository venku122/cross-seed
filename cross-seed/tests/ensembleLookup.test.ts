import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearcheeWithLabel } from "../src/searchee.js";

const assessed: SearcheeWithLabel[] = [];

describe.sequential("ensemble lookup", () => {
	let root: string;
	let db: typeof import("../src/db.js").db;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "cross-seed-ensemble-"));
		process.env.CONFIG_DIR = root;
		vi.resetModules();
		({ db } = await import("../src/db.js"));
		const { createAppDirHierarchy, getDefaultRuntimeConfig } =
			await import("../src/configuration.js");
		const { initializeLogger } = await import("../src/logger.js");
		const { setRuntimeConfig } = await import("../src/runtimeConfig.js");
		createAppDirHierarchy();
		initializeLogger({ verbose: false });
		setRuntimeConfig({
			...getDefaultRuntimeConfig(),
			seasonFromEpisodes: 1,
			useClientTorrents: false,
			torrentDir: undefined,
			dataDirs: [],
		});
		assessed.length = 0;
		// Keep production lookup, filesystem checks and deduplication real; stop at
		// assessment, which otherwise downloads an external indexer torrent.
		const decide = await import("../src/decide.js");
		vi.spyOn(decide, "assessCandidateCaching").mockImplementation(
			(_candidate, searchee) => {
				assessed.push(searchee);
				return Promise.resolve({ decision: "SIZE_MISMATCH" } as Awaited<
					ReturnType<typeof decide.assessCandidateCaching>
				>);
			},
		);
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await db.destroy();
		delete process.env.CONFIG_DIR;
		await rm(root, { recursive: true, force: true });
	});

	it("uses an ensemble-key search on a fresh database", async () => {
		await db.migrate.latest();
		const plan = await db.raw<{ detail: string }[]>(
			"EXPLAIN QUERY PLAN SELECT * FROM ensemble WHERE ensemble IN (?, ?) ORDER BY rowid",
			["zulu.S1", "alpha.S1"],
		);
		expect(
			plan.some((row) =>
				/SEARCH ensemble USING INDEX ensemble_key_index/.test(
					row.detail,
				),
			),
		).toBe(true);
	});

	it("upgrades populated databases and rolls the index down and up without losing alternate memberships", async () => {
		const { migrations } = await import("../src/migrations/migrations.js");
		const previous = (await migrations.getMigrations()).filter(
			(m) => m.name !== "18-ensemble-lookup-index",
		);
		await db.migrate.latest({
			migrationSource: {
				...migrations,
				getMigrations: () => Promise.resolve(previous),
			},
		});
		const rows = [
			{
				client_host: null,
				path: "/synthetic/shared",
				info_hash: null,
				ensemble: "zulu.S1",
				element: "1",
			},
			{
				client_host: null,
				path: "/synthetic/shared",
				info_hash: null,
				ensemble: "alpha.S1",
				element: "1",
			},
			{
				client_host: "synthetic-client",
				path: "/synthetic/client",
				info_hash: "synthetic-hash",
				ensemble: "zulu.S1",
				element: "2",
			},
		];
		await db("ensemble").insert(rows);
		const before = await db("ensemble").orderBy("rowid");
		await db.migrate.latest({ migrationSource: migrations });
		expect(await db("ensemble").orderBy("rowid")).toEqual(before);
		expect(
			(
				await db.raw<{ name: string }[]>("PRAGMA index_list(ensemble)")
			).map((i) => i.name),
		).toContain("ensemble_key_index");
		await db.migrate.down();
		expect(
			(
				await db.raw<{ name: string }[]>("PRAGMA index_list(ensemble)")
			).map((i) => i.name),
		).not.toContain("ensemble_key_index");
		expect(await db("ensemble").orderBy("rowid")).toEqual(before);
		await db.migrate.up();
		expect(await db("ensemble").orderBy("rowid")).toEqual(before);
		expect(
			await db("ensemble")
				.whereIn("ensemble", ["zulu.S1", "alpha.S1"])
				.orderBy("rowid"),
		).toEqual(before);
	});

	it("retains the first existing duplicate episode source across alternate title keys", async () => {
		await db.migrate.latest();
		// Reproduce the prepared index independently so this catches the source-order
		// regression even before the migration exists.
		await db.raw(
			"CREATE INDEX IF NOT EXISTS ensemble_key_index ON ensemble(ensemble)",
		);
		const first = join(root, "Zulu.Show.S01E01.mkv");
		const duplicate = join(root, "Alpha.Show.S01E01.mkv");
		const second = join(root, "Alpha.Show.S01E02.mkv");
		await Promise.all(
			[first, duplicate, second].map((path) =>
				writeFile(path, "episode"),
			),
		);
		await db("ensemble").insert([
			{
				client_host: null,
				path: first,
				ensemble: "zulushow.S1",
				element: "1",
			},
			{
				client_host: null,
				path: duplicate,
				ensemble: "alphashow.S1",
				element: "1",
			},
			{
				client_host: null,
				path: second,
				ensemble: "alphashow.S1",
				element: "2",
			},
			{
				client_host: null,
				path: first,
				ensemble: "alphashow.S1",
				element: "1",
			},
		]);
		const { checkNewCandidateMatch } = await import("../src/pipeline.js");
		const { Label } = await import("../src/logger.js");
		await checkNewCandidateMatch(
			{
				name: "Zulu.Show.AKA.Alpha.Show.S01.1080p.WEB",
				guid: "synthetic-season",
				link: "http://unused.invalid",
				tracker: "synthetic",
			},
			Label.RSS,
		);
		expect(assessed.length).toBeGreaterThan(0);
		for (const searchee of assessed) {
			expect(searchee.files.map((file) => file.path)).toEqual([
				first,
				second,
			]);
			expect(searchee.length).toBe(14);
		}
	});
});
