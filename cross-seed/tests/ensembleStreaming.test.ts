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
		refreshPath: string;
		host: string | null;
		generated: number;
		failAt: number;
		timerObserved: boolean;
		timerAtLastSource: boolean;
		dbProgress: boolean;
		dbAtLastSource: boolean;
	} => ({
		count: 600,
		refreshPath: "/synthetic",
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
			getClientSearchees: async () => {
				const searchees = Array.from(
					{ length: fixture.count },
					(_, i) => ({
						infoHash: String(i),
						name: "Review.Show.S01E01.mkv",
						title: "Review.Show.S01E01.mkv",
						length: 1,
						clientHost: fixture.host ?? "synthetic-client",
						savePath: "/synthetic",
						trackers: [],
						files: [
							{ name: String(i), path: String(i), length: 1 },
						],
					}),
				);
				const { upsertSearcheeClientDB } =
					await import("../src/searchee.js");
				await upsertSearcheeClientDB(
					searchees.map((source) => ({
						...source,
						savePath: fixture.refreshPath,
					})),
				);
				return { searchees };
			},
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
		/^insert into [`"]ensemble_membership[`"]/.test(query.sql) &&
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
		await database.db("ensemble_membership").del();
		await database.db("source_alias").del();
		await database.db("source_origin").del();
		await database.db("physical_path").del();
		await database.db("ensemble").del();
		fixture.count = 600;
		fixture.refreshPath = "/synthetic";
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

	async function runFixtureWriter() {
		const { writeEnsembleTorrentEntries } =
			await import("../src/ensembleWriter.js");
		const { cacheEnsembleTorrentEntry } = await import("../src/torrent.js");
		const sources = Array.from({ length: fixture.count }, (_, i) => ({
			infoHash: String(i),
			clientHost: fixture.host ?? undefined,
			name: "Review.Show.S01E01.mkv",
			title: "Review.Show.S01E01.mkv",
			savePath: "/synthetic",
			length: 1,
			files: [{ name: String(i), path: String(i), length: 1 }],
		}));
		await writeEnsembleTorrentEntries(sources, cacheEnsembleTorrentEntry);
	}
	async function read() {
		const { sourceMembershipQuery } = await import("../src/sourceStore.js");
		return sourceMembershipQuery(database.db).orderBy("m.selection_order");
	}
	it("does not publish a source for an empty client catalog", async () => {
		fixture.count = 0;
		await runFixtureWriter();
		expect(await read()).toEqual([]);
		expect(
			await database.db("source_origin").count({ n: "*" }).first(),
		).toEqual({ n: 0 });
	});
	it("writes complete sources before generating the entire catalog and preserves all named aliases", async () => {
		await runFixtureWriter();
		expect(firstWriteAfterSources).toBeGreaterThan(0);
		expect(firstWriteAfterSources).toBeLessThanOrEqual(64);
		expect(
			(await read()).map((r) => ({
				info_hash: r.info_hash,
				ensemble: r.ensemble,
			})),
		).toEqual(
			Array.from({ length: 600 }, (_, i) =>
				Array.from({ length: 3 }, (_, alias) => ({
					info_hash: String(i),
					ensemble: `alias-${alias}`,
				})),
			).flat(),
		);
	});
	it("keeps NULL-host aliases idempotent across rebuilds", async () => {
		fixture.count = 2;
		fixture.host = null;
		await runFixtureWriter();
		await runFixtureWriter();
		expect(
			(await read()).map((r) => ({ path: r.path, ensemble: r.ensemble })),
		).toEqual(
			Array.from({ length: 2 }, (_, i) =>
				Array.from({ length: 3 }, (_, alias) => ({
					path: `/synthetic/${i}`,
					ensemble: `alias-${alias}`,
				})),
			).flat(),
		);
	});
	it("does not overwrite a different named owner sharing the same path", async () => {
		fixture.count = 2;
		await database.db("ensemble").insert({
			client_host: "synthetic-client",
			path: "/synthetic/1",
			info_hash: "old",
			ensemble: "old",
			element: "1",
		});
		await (
			await import("../src/migrations/19-source-ownership.js")
		).default.up(database.db);
		await runFixtureWriter();
		expect((await read()).map((r) => r.ensemble)).toEqual([
			"old",
			"alias-0",
			"alias-1",
			"alias-2",
			"alias-0",
			"alias-1",
			"alias-2",
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
		await writeEnsembleTorrentEntries(sources, async (source) => {
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
		});
		expect(peak).toBeGreaterThan(1);
		expect(peak).toBeLessThanOrEqual(64);
		expect((await read()).map((r) => r.info_hash)).toEqual(
			sources.map((s) => s.infoHash),
		);
	});
	it("uses source-owned publication through actual startup torrent indexing", async () => {
		const { indexTorrentsAndDataDirs } = await import("../src/torrent.js");
		await indexTorrentsAndDataDirs({ startup: true });
		expect(
			(await read()).map((r) => ({ path: r.path, ensemble: r.ensemble })),
		).toEqual(
			Array.from({ length: 600 }, (_, i) => ({
				path: `/synthetic/${i}`,
				ensemble: "reviewshow.S1",
			})),
		);
	});
	it("lets timers run before finishing a large membership rebuild", async () => {
		const immediate = setImmediate(() => {
			fixture.timerObserved = true;
		});
		try {
			await runFixtureWriter();
			expect(fixture.timerAtLastSource).toBe(true);
		} finally {
			clearImmediate(immediate);
		}
	});
	it("allows other database readers between complete source transactions", async () => {
		await runFixtureWriter();
		expect(fixture.dbAtLastSource).toBe(true);
	});
	it("retains successful source publications and invalidates health when later generation fails", async () => {
		const { getHealthGeneration } =
			await import("../src/healthGeneration.js");
		const before = getHealthGeneration();
		fixture.failAt = 401;
		await expect(runFixtureWriter()).rejects.toThrow(
			"synthetic generation failure",
		);
		const rows = await read();
		expect(rows.some((r) => r.info_hash === "400")).toBe(true);
		expect(rows.some((r) => r.info_hash === "401")).toBe(false);
		expect(rows.filter((r) => r.info_hash === "400")).toHaveLength(3);
		expect(getHealthGeneration()).toBeGreaterThan(before);
	});
	it("rolls back the failed source while keeping earlier commits after later SQL failure", async () => {
		const { getHealthGeneration } =
			await import("../src/healthGeneration.js");
		const before = getHealthGeneration();
		await database.db.raw(
			`CREATE TRIGGER fail_stream BEFORE INSERT ON ensemble_membership WHEN NEW.element='401' BEGIN SELECT RAISE(ABORT,'synthetic SQL failure'); END`,
		);
		try {
			await expect(runFixtureWriter()).rejects.toThrow(
				"synthetic SQL failure",
			);
			const rows = await read();
			expect(rows).toHaveLength(401 * 3);
			expect(rows.some((r) => r.info_hash === "401")).toBe(false);
			expect(
				await database
					.db<{
						revision: number;
						source_key: string;
					}>("source_origin")
					.where({ source_key: "401" })
					.first(),
			).toBeUndefined();
			expect(getHealthGeneration()).toBeGreaterThan(before);
		} finally {
			await database.db.raw("DROP TRIGGER fail_stream");
		}
	});
	it("actual cleanup keeps atomic cached memberships instead of regenerating returned RPC arrays", async () => {
		fixture.count = 2;
		fixture.refreshPath = "/latest";
		const { upsertSearcheeClientDB } = await import("../src/searchee.js");
		const cached = Array.from({ length: 2 }, (_, i) => ({
			infoHash: String(i),
			clientHost: "synthetic-client",
			name: "Review.Show.S01E01.mkv",
			title: "Review.Show.S01E01.mkv",
			savePath: "/latest",
			length: 1,
			trackers: [],
			files: [{ name: String(i), path: String(i), length: 1 }],
		}));
		await upsertSearcheeClientDB(cached);
		const before = await read();
		await database.cleanupDB();
		expect(await read()).toEqual(before);
		expect((await read()).map((r) => r.path)).toEqual([
			"/latest/0",
			"/latest/1",
		]);
		expect(fixture.generated).toBe(0);
	});
});
