import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const fixture = vi.hoisted(
	(): {
		count: number;
		host: string | null;
		generated: number;
		failAt: number;
		timerObserved: boolean;
		timerAtLastSource: boolean;
		dbProgress: boolean;
		dbAtLastSource: boolean;
	} => ({
		count: 600,
		host: "synthetic-client",
		generated: 0,
		failAt: -1,
		timerObserved: false,
		timerAtLastSource: false,
		dbProgress: false,
		dbAtLastSource: false,
	}),
);
vi.mock("fs/promises", async (original) => ({
	...(await original<typeof import("fs/promises")>()),
	access: async () => {},
}));
vi.mock("../src/clients/TorrentClient.js", () => ({
	getClients: () => [
		{
			label: "Synthetic",
			clientHost: "synthetic-client",
			getClientSearchees: () =>
				Promise.resolve({
					searchees: Array.from(
						{ length: fixture.count },
						(_, i) => ({
							infoHash: String(i),
							name: "Review.Show.S01E01.mkv",
							title: "Review.Show.S01E01.mkv",
							length: 1,
							clientHost: fixture.host ?? undefined,
							savePath: "/synthetic",
							files: [
								{ name: String(i), path: String(i), length: 1 },
							],
						}),
					),
				}),
		},
	],
}));
vi.mock("../src/torrent.js", async (original) => ({
	...(await original<typeof import("../src/torrent.js")>()),
	cacheEnsembleTorrentEntry: async (source: { infoHash: string }) => {
		const i = Number(source.infoHash);
		await Promise.resolve();
		fixture.generated++;
		if (i === fixture.failAt)
			throw new Error("synthetic generation failure");
		if (i === fixture.count - 1) {
			fixture.timerAtLastSource = fixture.timerObserved;
			fixture.dbAtLastSource = fixture.dbProgress;
		}
		return Array.from({ length: 3 }, (_, alias) => ({
			client_host: fixture.host,
			path: `/synthetic/${i}`,
			info_hash: source.infoHash,
			ensemble: `alias-${alias}`,
			element: String(i),
		}));
	},
}));
let database: typeof import("../src/db.js");
let directory: string;
let firstWriteAfterSources = 0;
const onQuery = (query: { sql: string }) => {
	if (
		/^insert into [`"]ensemble_stage_\d+[`"]/.test(query.sql) &&
		!firstWriteAfterSources
	) {
		firstWriteAfterSources = fixture.generated;
		void database
			.db("ensemble")
			.count("* as n")
			.then(() => {
				fixture.dbProgress = true;
			});
	}
};

describe.sequential("cooperative ensemble refresh", () => {
	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), "cross-seed-stream-test-"));
		process.env.CONFIG_DIR = directory;
		database = await import("../src/db.js");
		(
			database.db.client as { connectionSettings: { filename: string } }
		).connectionSettings.filename = ":memory:";
		const { createAppDirHierarchy } =
			await import("../src/configuration.js");
		createAppDirHierarchy();
		const { initializeLogger } = await import("../src/logger.js");
		initializeLogger({ verbose: false });
		await database.db.migrate.latest();
		database.db.on("query", onQuery);
	});
	beforeEach(async () => {
		await database.db("ensemble").del();
		fixture.count = 600;
		fixture.host = "synthetic-client";
		fixture.generated = 0;
		fixture.failAt = -1;
		fixture.timerObserved = false;
		fixture.timerAtLastSource = false;
		fixture.dbProgress = false;
		fixture.dbAtLastSource = false;
		firstWriteAfterSources = 0;
		const { getDefaultRuntimeConfig } =
			await import("../src/configuration.js");
		const { setRuntimeConfig } = await import("../src/runtimeConfig.js");
		setRuntimeConfig({
			...getDefaultRuntimeConfig(),
			useClientTorrents: true,
			seasonFromEpisodes: 1,
			dataDirs: [],
		});
	});
	afterAll(async () => {
		database.db.removeListener("query", onQuery);
		await database.db.destroy();
		delete process.env.CONFIG_DIR;
		await rm(directory, { recursive: true, force: true });
	});
	it("does not start a write transaction for an empty client catalog", async () => {
		fixture.count = 0;
		const statements: string[] = [];
		const collect = (query: { sql: string }) => {
			statements.push(query.sql);
		};
		database.db.on("query", collect);
		try {
			await database.cleanupDB();
		} finally {
			database.db.removeListener("query", collect);
		}
		expect(statements.filter((sql) => /^BEGIN|^COMMIT/i.test(sql))).toEqual(
			[],
		);
	});

	it("writes bounded rows before generating the entire source catalog", async () => {
		await database.cleanupDB();
		expect(firstWriteAfterSources).toBeGreaterThan(0);
		expect(firstWriteAfterSources).toBeLessThanOrEqual(256);
		const rows = await database
			.db("ensemble")
			.select("info_hash", "ensemble")
			.orderByRaw("rowid");
		expect(rows).toEqual(
			Array.from({ length: 600 }, (_, i) => ({
				info_hash: String(i),
				ensemble: "alias-2",
			})),
		);
	});
	it("preserves ordered NULL-host aliases and exact repeats", async () => {
		fixture.count = 2;
		fixture.host = null;
		await database.cleanupDB();
		await database.cleanupDB();
		const rows = await database
			.db("ensemble")
			.select("path", "ensemble")
			.orderByRaw("rowid");
		expect(rows).toEqual(
			Array.from({ length: 2 }, () =>
				Array.from({ length: 2 }, (_, i) =>
					Array.from({ length: 3 }, (_, alias) => ({
						path: `/synthetic/${i}`,
						ensemble: `alias-${alias}`,
					})),
				),
			).flat(2),
		);
	});
	it("retains existing named row order while updating the last alias", async () => {
		fixture.count = 2;
		await database.db("ensemble").insert({
			client_host: "synthetic-client",
			path: "/synthetic/1",
			info_hash: "old",
			ensemble: "old",
			element: "1",
		});
		await database.cleanupDB();
		expect(
			await database
				.db("ensemble")
				.select("path", "ensemble")
				.orderByRaw("rowid"),
		).toEqual([
			{ path: "/synthetic/1", ensemble: "alias-2" },
			{ path: "/synthetic/0", ensemble: "alias-2" },
		]);
	});

	it("generates concurrently in bounded groups without changing source order", async () => {
		const { writeEnsembleTorrentEntries } =
			await import("../src/ensembleWriter.js");
		let active = 0,
			peak = 0;
		const sources = Array.from({ length: 100 }, (_, i) => ({
			infoHash: String(i),
			name: "Fixture",
			title: "Fixture",
			length: 1,
			files: [],
		}));
		await writeEnsembleTorrentEntries(
			sources,
			async (source, ...extra: unknown[]) => {
				expect(extra).toEqual([]);
				peak = Math.max(peak, ++active);
				await new Promise((done) =>
					setTimeout(done, Number(source.infoHash) % 2 ? 0 : 2),
				);
				active--;
				return [
					{
						client_host: null,
						path: `/synthetic/${source.infoHash}`,
						info_hash: source.infoHash,
						ensemble: "fixture",
						element: source.infoHash,
					},
				];
			},
		);
		expect(peak).toBeGreaterThan(1);
		expect(peak).toBeLessThanOrEqual(64);
		expect(
			(
				await database
					.db<{ info_hash: string }>("ensemble")
					.select("info_hash")
					.orderByRaw("rowid")
			).map((row) => row.info_hash),
		).toEqual(sources.map((source) => source.infoHash));
	});

	it("uses the bounded writer through actual startup torrent indexing", async () => {
		const { indexTorrentsAndDataDirs } = await import("../src/torrent.js");
		await indexTorrentsAndDataDirs({ startup: true });
		const rows = await database
			.db<{ path: string; ensemble: string }>("ensemble")
			.select("path", "ensemble")
			.orderByRaw("rowid");
		expect(rows).toEqual(
			Array.from({ length: 600 }, (_, i) => ({
				path: `/synthetic/${i}`,
				ensemble: "reviewshow.S1",
			})),
		);
		expect(
			await database.db.raw(
				"SELECT name FROM sqlite_temp_master WHERE name LIKE 'ensemble_stage_%'",
			),
		).toEqual([]);
	});

	it("lets timers run before finishing a large membership rebuild", async () => {
		const immediate = setImmediate(() => {
			fixture.timerObserved = true;
		});
		try {
			await database.cleanupDB();
			expect(fixture.timerAtLastSource).toBe(true);
		} finally {
			clearImmediate(immediate);
		}
	});
	it("allows other database readers during staged generation", async () => {
		await database.cleanupDB();
		expect(fixture.dbAtLastSource).toBe(true);
		const tables: unknown = await database.db.raw(
			"SELECT name FROM sqlite_temp_master WHERE name LIKE 'ensemble_stage_%'",
		);
		expect(tables).toEqual([]);
	});

	it("rolls back streamed writes when later source generation fails", async () => {
		await database.db("ensemble").insert({
			client_host: null,
			path: "/synthetic/original",
			ensemble: "original",
			element: "1",
		});
		fixture.failAt = 401;
		await expect(database.cleanupDB()).rejects.toThrow(
			"synthetic generation failure",
		);
		expect(
			await database.db.raw(
				"SELECT name FROM sqlite_temp_master WHERE name LIKE 'ensemble_stage_%'",
			),
		).toEqual([]);
		expect(await database.db("ensemble").select("path")).toEqual([
			{ path: "/synthetic/original" },
		]);
	});
	it("rolls back all membership batches after a later SQL failure", async () => {
		await database.db.raw(
			`CREATE TRIGGER fail_stream BEFORE INSERT ON ensemble WHEN NEW.path='/synthetic/401' BEGIN SELECT RAISE(ABORT, 'synthetic SQL failure'); END`,
		);
		try {
			await expect(database.cleanupDB()).rejects.toThrow(
				"synthetic SQL failure",
			);
			expect(
				await database.db.raw(
					"SELECT name FROM sqlite_temp_master WHERE name LIKE 'ensemble_stage_%'",
				),
			).toEqual([]);
			expect(
				await database.db("ensemble").count("* as n").first(),
			).toEqual({ n: 0 });
		} finally {
			await database.db.raw("DROP TRIGGER fail_stream");
		}
	});
});
