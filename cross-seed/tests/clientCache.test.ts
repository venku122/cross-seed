import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientSearcheeRow, SearcheeClient } from "../src/searchee.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const root = await mkdtemp(join(tmpdir(), "cross-seed-cache-tests-"));
process.env.CONFIG_DIR = root;
const { db } = await import("../src/db.js");
const { cachedClientTorrents, cachedLegacyClientTorrents } =
	await import("../src/clients/clientCache.js");
const { clientSearcheeModified } =
	await import("../src/clients/TorrentClient.js");
const { updateSearcheeClientDB, upsertSearcheeClientDB } =
	await import("../src/searchee.js");
const { createAppDirHierarchy } = await import("../src/configuration.js");
const hashes = Array.from({ length: 1001 }, (_, i) => String(i));
const queries: { sql: string; bindings?: readonly unknown[] }[] = [];

beforeAll(async () => {
	createAppDirHierarchy();
	await db.migrate.latest();
	for (let offset = 0; offset < hashes.length; offset += 100) {
		await db("client_searchee").insert(
			hashes.slice(offset, offset + 100).map((info_hash) => ({
				client_host: "fixture",
				info_hash,
				name: "Fixture",
				title: "Fixture",
				files: "[]",
				length: 0,
				save_path: "/synthetic",
				category: null,
				tags: null,
				trackers: "[]",
			})),
		);
	}
	await db("client_searchee").insert({
		client_host: "other",
		info_hash: "0",
		name: "Different",
		files: "bad JSON",
	});
	db.on("query", (query: { sql: string; bindings?: readonly unknown[] }) =>
		queries.push(query),
	);
});

describe.sequential("bounded client cache reads", () => {
	it("preserves input order and client isolation across bounded hydration reads", async () => {
		queries.splice(0);
		const output: {
			infoHash: string;
			useCache: boolean;
			dbTorrent?: ClientSearcheeRow;
		}[] = [];
		for await (const entry of cachedLegacyClientTorrents(
			hashes.toReversed(),
			"fixture",
			(h) => h,
			(_h, row) =>
				!clientSearcheeModified(
					"fixture",
					row,
					"Fixture",
					"/synthetic",
				),
			true,
		))
			output.push(entry);
		expect(output.map((e) => e.infoHash)).toEqual(hashes.toReversed());
		expect(output.every((e) => e.dbTorrent?.name === "Fixture")).toBe(true);
		expect(queries.filter((q) => q.sql.startsWith("select"))).toHaveLength(
			8,
		);
		expect(queries.every((q) => (q.bindings?.length ?? 0) <= 501)).toBe(
			true,
		);
	});

	it("never fetches file JSON when cached results are omitted", async () => {
		queries.splice(0);
		let length = 0;
		for await (const entry of cachedLegacyClientTorrents(
			hashes,
			"fixture",
			(h) => h,
			() => true,
			false,
		)) {
			expect(entry.dbTorrent).toBeUndefined();
			length++;
		}
		expect(length).toBe(1001);
		expect(queries).toHaveLength(3);
		expect(
			queries.every(
				(q) => !q.sql.includes("files") && !q.sql.includes("select *"),
			),
		).toBe(true);
	});

	it("hydrates only unchanged rows and leaves missing or changed rows for refresh", async () => {
		queries.splice(0);
		const output: {
			infoHash: string;
			useCache: boolean;
			dbTorrent?: ClientSearcheeRow;
		}[] = [];
		for await (const entry of cachedLegacyClientTorrents(
			["missing", "1", "0"],
			"fixture",
			(h) => h,
			(h, row) =>
				!clientSearcheeModified(
					"fixture",
					row,
					h === "1" ? "Renamed" : "Fixture",
					"/synthetic",
				),
			true,
		))
			output.push(entry);
		expect(output.map((e) => e.useCache)).toEqual([false, false, true]);
		expect(output.map((e) => e.dbTorrent?.info_hash)).toEqual([
			undefined,
			undefined,
			"0",
		]);
		expect(
			queries.find((q) => q.sql.includes("select *"))?.bindings,
		).toEqual(["fixture", "0"]);
	});
	it("limits serialized hydration to one oversized row at a time", async () => {
		const large = JSON.stringify([
			{ name: "oversized", path: "x".repeat(1_100_000), length: 1 },
		]);
		for (const info_hash of ["large1", "large2", "large3"])
			await db("client_searchee").insert({
				client_host: "fixture",
				info_hash,
				name: "Large",
				files: large,
			});
		queries.splice(0);
		let count = 0;
		for await (const entry of cachedLegacyClientTorrents(
			["large1", "large2", "large3"],
			"fixture",
			(h) => h,
			() => true,
			true,
		)) {
			expect(entry.dbTorrent?.files).toHaveLength(large.length);
			count++;
		}
		expect(count).toBe(3);
		expect(queries.filter((q) => q.sql.includes("select *"))).toHaveLength(
			3,
		);
	});
	it("revalidates cache metadata changed between check and hydration", async () => {
		let update: Promise<number> | undefined;
		const flags: boolean[] = [];
		const names: (string | undefined)[] = [];
		for await (const entry of cachedLegacyClientTorrents(
			["1"],
			"fixture",
			(h) => h,
			(_h, row) => {
				update ??= db("client_searchee")
					.where({ client_host: "fixture", info_hash: "1" })
					.update({ name: "Concurrent" })
					.then((count) => count);
				return !clientSearcheeModified(
					"fixture",
					row,
					"Fixture",
					"/synthetic",
				);
			},
			true,
		)) {
			flags.push(entry.useCache);
			names.push(entry.dbTorrent?.name);
		}
		await update;
		expect(names).toEqual(["Concurrent"]);
		expect(flags).toEqual([false]);
	});
	it("bounds hydration when file metadata grows after the lightweight read", async () => {
		const growing = ["growing1", "growing2", "growing3"];
		const large = JSON.stringify([
			{ name: "oversized", path: "x".repeat(1_100_000), length: 1 },
		]);
		for (const info_hash of growing)
			await db("client_searchee").insert({
				client_host: "fixture",
				info_hash,
				name: "Growing",
				files: "[]",
			});
		let update: Promise<number> | undefined;
		let largestRead = 0,
			count = 0;
		const observe = (rows: ClientSearcheeRow[], query: { sql: string }) => {
			if (query.sql.includes("select *") && Array.isArray(rows))
				largestRead = Math.max(
					largestRead,
					rows.reduce(
						(sum, row) => sum + Buffer.byteLength(row.files),
						0,
					),
				);
		};
		db.on("query-response", observe);
		try {
			for await (const entry of cachedLegacyClientTorrents(
				growing,
				"fixture",
				(h) => h,
				() => {
					update ??= db("client_searchee")
						.where("client_host", "fixture")
						.whereIn("info_hash", growing)
						.update({ files: large })
						.then((n) => n);
					return true;
				},
				true,
			)) {
				expect(entry.dbTorrent?.files).toBe(large);
				count++;
			}
			await update;
			expect(count).toBe(3);
			expect(largestRead).toBeLessThanOrEqual(Buffer.byteLength(large));
		} finally {
			db.removeListener("query-response", observe);
		}
	});
	it("writes the first cache batch before serializing the full refresh", async () => {
		const searchees: SearcheeClient[] = Array.from(
			{ length: 250 },
			(_, i) => ({
				clientHost: "serialization",
				infoHash: String(i).padStart(40, "0"),
				name: `Fixture.${i}`,
				title: `Fixture.${i}`,
				savePath: "/synthetic",
				length: 1,
				files: [{ name: `file${i}`, path: `file${i}`, length: 1 }],
				trackers: ["tracker.invalid"],
			}),
		);
		const knownFiles = new Set<unknown>(searchees.map((s) => s.files));
		const stringify = JSON.stringify;
		let serialized = 0;
		const writes: number[] = [];
		const observe = (query: { sql: string }) => {
			if (
				query.sql.startsWith("insert into") &&
				query.sql.includes("client_searchee")
			)
				writes.push(serialized);
		};
		const spy = vi
			.spyOn(JSON, "stringify")
			.mockImplementation((value, replacer, space) => {
				if (knownFiles.has(value)) serialized++;
				return stringify(value, replacer, space);
			});
		db.on("query", observe);
		try {
			await updateSearcheeClientDB(
				"serialization",
				searchees,
				new Set(searchees.map((s) => s.infoHash)),
			);
			expect(writes).toEqual([100, 200, 250]);
			expect(
				await db("client_searchee")
					.where("client_host", "serialization")
					.select("info_hash"),
			).toHaveLength(250);
		} finally {
			spy.mockRestore();
			db.removeListener("query", observe);
		}
	});
});

const { getHealthGeneration } = await import("../src/healthGeneration.js");
function publicationFixture(host: string, hash: string): SearcheeClient {
	return {
		clientHost: host,
		infoHash: hash,
		name: "Fixture",
		title: "Fixture",
		savePath: "/fixture",
		length: 1,
		files: [{ name: "file", path: "file", length: 1 }],
		trackers: [],
	};
}
describe.sequential("cache transaction publication", () => {
	it("retires all exact legacy client origins while preserving other hosts and data sources", async () => {
		const legacy = [
			{
				id: "retirement-client-one",
				clientHost: "retirement",
				infoHash: "same",
			},
			{
				id: "retirement-client-two",
				clientHost: "retirement",
				infoHash: "same",
			},
			{
				id: "retirement-other-host",
				clientHost: "other-host",
				infoHash: "same",
			},
			{ id: "retirement-data", clientHost: null, infoHash: null },
		];
		await db("source_origin").insert(
			legacy.map(({ id, clientHost, infoHash }) => ({
				id,
				source_key: id,
				namespace_id: "legacy-unknown",
				state: "legacy-unknown",
				metadata: JSON.stringify({ clientHost, infoHash }),
				revision: 0,
			})),
		);
		expect(
			await upsertSearcheeClientDB([
				publicationFixture("retirement", "same"),
				publicationFixture("retirement", "fresh"),
			]),
		).toBe(true);
		const rows = await db<{ id: string; state: string; revision: number }>(
			"source_origin",
		)
			.whereIn(
				"id",
				legacy.map((origin) => origin.id),
			)
			.select("id", "state", "revision");
		const byId = new Map(rows.map((row) => [row.id, row]));
		for (const id of ["retirement-client-one", "retirement-client-two"])
			expect(byId.get(id)).toMatchObject({
				state: "superseded",
				revision: 1,
			});
		for (const id of ["retirement-other-host", "retirement-data"])
			expect(byId.get(id)).toMatchObject({
				state: "legacy-unknown",
				revision: 0,
			});
	});
	it("creates 100 isolated client origins without per-source SQL transactions", async () => {
		const values = Array.from({ length: 100 }, (_, i) =>
			publicationFixture("bulk-new", String(i)),
		);
		queries.splice(0);
		expect(await upsertSearcheeClientDB(values)).toBe(true);
		expect(queries.length).toBeLessThanOrEqual(35);
		const legacyLookups = queries.filter(
			(query) =>
				query.sql.includes("source_origin") &&
				query.sql.includes("$.clientHost") &&
				query.sql.includes("$.infoHash"),
		);
		expect(legacyLookups).toHaveLength(1);
		const lookup = legacyLookups[0];
		const bindings = (lookup.bindings ?? []).map((value) => {
			if (typeof value !== "string")
				throw new Error("Expected string source identity");
			return value;
		});
		const plan = await db.raw<{ detail: string }[]>(
			`EXPLAIN QUERY PLAN ${lookup.sql}`,
			bindings,
		);
		expect(
			plan.some(
				(row) =>
					row.detail.includes("source_legacy_client_identity") &&
					row.detail.includes("<expr>=? AND <expr>=?"),
			),
		).toBe(true);
		expect(
			await db("source_origin")
				.whereRaw("json_extract(metadata,'$.clientHost')=?", [
					"bulk-new",
				])
				.count({ n: "*" })
				.first(),
		).toEqual({ n: 100 });
	});

	it("publishes 100 existing client origins with bounded SQL and no duplicated file metadata", async () => {
		const { setRuntimeConfig } = await import("../src/runtimeConfig.js");
		const { getDefaultRuntimeConfig } =
			await import("../src/configuration.js");
		setRuntimeConfig({
			...getDefaultRuntimeConfig(),
			seasonFromEpisodes: 1,
		});
		const values = Array.from({ length: 100 }, (_, i) => ({
			...publicationFixture("bulk-existing", String(i)),
			name: `Fixture.S01E${String(i + 1).padStart(2, "0")}`,
			title: `Fixture.S01E${String(i + 1).padStart(2, "0")}`,
			files: [{ name: "large.mkv", path: `${i}/large.mkv`, length: 1 }],
			trackers: ["https://tracker.invalid/announce"],
		}));
		await upsertSearcheeClientDB(values);
		const before = await db("ensemble_membership as member")
			.join("source_origin as origin", "origin.id", "member.origin_id")
			.whereIn(
				"origin.source_key",
				values.map((s) => s.infoHash),
			)
			.whereRaw("json_extract(origin.metadata,'$.clientHost')=?", [
				"bulk-existing",
			])
			.select<
				{
					origin_id: string;
					path_id: number;
					ensemble: string;
					element: string;
					selection_order: number;
				}[]
			>("member.*")
			.orderBy("member.selection_order");
		queries.splice(0);
		expect(await upsertSearcheeClientDB(values)).toBe(true);
		const publicationQueries = queries.length;
		expect(publicationQueries).toBeLessThanOrEqual(30);
		expect(
			queries.some((sql) =>
				/^(delete from|insert into) [`"]?ensemble_membership/i.test(
					sql.sql,
				),
			),
		).toBe(false);
		const after = await db("ensemble_membership")
			.whereIn(
				"origin_id",
				before.map((row) => row.origin_id),
			)
			.select("*")
			.orderBy("selection_order");
		expect(after).toEqual(before);
		const origin = await db("source_origin")
			.where("id", before[0].origin_id)
			.first<{ metadata: string }>("metadata");
		expect(JSON.parse(origin.metadata) as unknown).toEqual({
			clientHost: "bulk-existing",
			infoHash: "0",
			name: values[0].name,
			title: values[0].title,
			savePath: "/fixture",
		});
		const cached = await db("client_searchee")
			.where({ client_host: "bulk-existing", info_hash: "0" })
			.first<{ files: string; trackers: string }>();
		expect(JSON.parse(cached.files) as unknown).toEqual(values[0].files);
		expect(JSON.parse(cached.trackers) as unknown).toEqual(
			values[0].trackers,
		);
	});

	it("reconciles exact named migrated legacy absence in the first validated empty snapshot", async () => {
		const { bindClientSourceLocator, sourceMembershipQuery } =
			await import("../src/sourceStore.js");
		const { default: migration } =
			await import("../src/migrations/19-source-ownership.js");
		await db("client_searchee").insert({
			client_host: "migrated-empty",
			info_hash: "legacy",
			name: "legacy",
			files: "[]",
		});
		await db("ensemble").insert([
			{
				client_host: "migrated-empty",
				info_hash: "legacy",
				path: "/legacy/named",
				ensemble: "migrated",
				element: "1",
			},
			{
				client_host: null,
				info_hash: "legacy",
				path: "/legacy/ambiguous",
				ensemble: "migrated",
				element: "1",
			},
		]);
		await migration.up(db);
		bindClientSourceLocator(
			"migrated-empty",
			"https://migration.example/rpc",
		);
		expect(
			(
				(await sourceMembershipQuery(db)) as {
					client_host: string | null;
					path: string;
				}[]
			).some((row) => row.client_host === "migrated-empty"),
		).toBe(true);
		expect(
			await updateSearcheeClientDB("migrated-empty", [], new Set()),
		).toBe(true);
		expect(
			await db("client_searchee")
				.where({ client_host: "migrated-empty", info_hash: "legacy" })
				.first(),
		).toBeUndefined();
		const remaining = (await sourceMembershipQuery(db)) as {
			client_host: string | null;
			path: string;
		}[];
		expect(
			remaining.some((row) => row.client_host === "migrated-empty"),
		).toBe(false);
		expect(remaining.some((row) => row.path === "/legacy/ambiguous")).toBe(
			true,
		);
	});

	it("rejects a complete cache-hit snapshot when its seen origin changed after hydration", async () => {
		const { beginClientCacheOperation } =
			await import("../src/clientCachePublication.js");
		await upsertSearcheeClientDB([publicationFixture("seen-hit", "hit")]);
		const old = beginClientCacheOperation("seen-hit");
		await upsertSearcheeClientDB([
			{ ...publicationFixture("seen-hit", "hit"), savePath: "/new" },
		]);
		expect(
			await updateSearcheeClientDB("seen-hit", [], new Set(["hit"]), old),
		).toBe(false);
	});
	it("rejects cache hits through persisted aliases without fresh full-snapshot upserts", async () => {
		const { beginClientCacheOperation } =
			await import("../src/clientCachePublication.js");
		const aliases = new Map([
			["primary", ["alternate"]],
			["alternate", ["primary"]],
		]);
		await upsertSearcheeClientDB(
			[
				publicationFixture("seen-alias", "primary"),
				publicationFixture("seen-alias", "alternate"),
			],
			undefined,
			aliases,
		);
		const old = beginClientCacheOperation("seen-alias");
		await upsertSearcheeClientDB([
			{
				...publicationFixture("seen-alias", "primary"),
				savePath: "/new",
			},
		]);
		expect(
			await updateSearcheeClientDB(
				"seen-alias",
				[],
				new Set(["primary", "alternate"]),
				old,
			),
		).toBe(false);
	});
	it("does not bootstrap cache data from a known different endpoint namespace", async () => {
		const { bindClientSourceLocator } =
			await import("../src/sourceStore.js");
		bindClientSourceLocator("uri-cache", "http://fixture.example/rpc");
		await upsertSearcheeClientDB([publicationFixture("uri-cache", "same")]);
		bindClientSourceLocator("uri-cache", "https://fixture.example/rpc");
		const output: { useCache: boolean; dbTorrent?: ClientSearcheeRow }[] =
			[];
		for await (const entry of cachedClientTorrents(
			["same"],
			"uri-cache",
			(hash) => hash,
			(_hash, row) => Boolean(row),
			true,
		))
			output.push(entry);
		expect(output[0]?.useCache).toBe(false);
		expect(output[0]?.dbTorrent).toBeUndefined();
	});

	it("retains ordering state only until the oldest active lease is released", async () => {
		const publication = await import("../src/clientCachePublication.js");
		const stats = publication.getClientCachePublicationStats;
		const before = stats();
		const held = publication.beginClientCacheOperation("lease-gc");
		for (let i = 0; i < 20; i++)
			await upsertSearcheeClientDB([
				publicationFixture("lease-gc", String(i)),
			]);
		expect(stats().origins).toBe(before.origins + 20);
		expect(stats().activeLeases).toBe(before.activeLeases + 1);
		publication.releaseClientCacheOperation(held);
		expect(stats()).toMatchObject({
			origins: before.origins,
			aliases: before.aliases,
			activeLeases: before.activeLeases,
		});
	});

	it("yields to a scheduled database reader after the first committed source batch", async () => {
		const { setImmediate } = await import("node:timers/promises");
		const values = Array.from({ length: 300 }, (_, i) =>
			publicationFixture("yield-publication", String(i)),
		);
		let observed!: Promise<number>;
		let scheduled = false;
		const observe = (query: { sql: string }) => {
			if (
				!scheduled &&
				query.sql.startsWith("insert into") &&
				query.sql.includes("client_searchee")
			) {
				scheduled = true;
				observed = setImmediate().then(async () =>
					Number(
						(
							await db("client_searchee")
								.where("client_host", "yield-publication")
								.count({ n: "*" })
								.first()
						)?.n,
					),
				);
			}
		};
		db.on("query", observe);
		try {
			await upsertSearcheeClientDB(values);
			expect(await observed).toBe(100);
		} finally {
			db.removeListener("query", observe);
		}
	});

	it("captures the endpoint namespace before restart and rejects publication into a rebound endpoint", async () => {
		const store = await import("../src/sourceStore.js");
		const { beginClientCacheOperation, restartClientCachePublication } =
			await import("../src/clientCachePublication.js");
		store.bindClientSourceLocator(
			"endpoint-rebind",
			"http://old.example/rpc",
		);
		const old = beginClientCacheOperation("endpoint-rebind");
		expect(old.sourceLocator).toBe("http://old.example/rpc");
		restartClientCachePublication();
		store.bindClientSourceLocator(
			"endpoint-rebind",
			"https://new.example/rpc",
		);
		expect(
			await upsertSearcheeClientDB(
				[publicationFixture("endpoint-rebind", "late")],
				old,
			),
		).toBe(false);
		await upsertSearcheeClientDB([
			publicationFixture("endpoint-rebind", "fresh"),
		]);
		expect(
			await db("source_namespace")
				.where({ type: "client", locator: "https://new.example/rpc" })
				.first(),
		).toBeDefined();
		expect(
			await db("source_namespace")
				.where({ type: "client", locator: "http://old.example/rpc" })
				.first(),
		).toBeUndefined();
	});

	it("rejects complete acceptance when a newer scoped addition cannot be pruned", async () => {
		const { beginClientCacheOperation } =
			await import("../src/clientCachePublication.js");
		const old = beginClientCacheOperation("empty-race");
		await upsertSearcheeClientDB([publicationFixture("empty-race", "new")]);
		expect(
			await updateSearcheeClientDB("empty-race", [], new Set(), old),
		).toBe(false);
		expect(
			await db("client_searchee")
				.where({ client_host: "empty-race", info_hash: "new" })
				.first(),
		).toBeDefined();
	});

	it("returns rejected acceptance for an older complete writer", async () => {
		const { beginClientCacheOperation } =
			await import("../src/clientCachePublication.js");
		const lease = beginClientCacheOperation("acceptance");
		await upsertSearcheeClientDB([publicationFixture("acceptance", "new")]);
		expect(
			await updateSearcheeClientDB(
				"acceptance",
				[publicationFixture("acceptance", "new")],
				new Set(["new"]),
				lease,
			),
		).toBe(false);
	});
	it("invalidates a released lease so its response cannot publish later", async () => {
		const publication = await import("../src/clientCachePublication.js");
		const lease = publication.beginClientCacheOperation("released");
		publication.releaseClientCacheOperation(lease);
		expect(
			await upsertSearcheeClientDB(
				[publicationFixture("released", "late")],
				lease,
			),
		).toBe(false);
	});

	it("rolls back an old session suspended in its transaction and fences new session publication", async () => {
		const {
			beginClientCacheOperation,
			restartClientCachePublication,
			publishClientCacheBatch,
		} = await import("../src/clientCachePublication.js");
		let release!: () => void, entered!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const before = getHealthGeneration();
		const old = publishClientCacheBatch(
			beginClientCacheOperation("restart-active"),
			["old"],
			async (trx) => {
				await trx("client_searchee").insert({
					client_host: "restart-active",
					info_hash: "old",
					name: "old",
					files: "[]",
				});
				entered();
				await held;
			},
		);
		const rejected = expect(old).rejects.toThrow("concurrency");
		await ready;
		restartClientCachePublication();
		const fresh = upsertSearcheeClientDB([
			publicationFixture("restart-active", "fresh"),
		]);
		release();
		await rejected;
		await fresh;
		expect(
			await db("client_searchee")
				.where({ client_host: "restart-active", info_hash: "old" })
				.first(),
		).toBeUndefined();
		expect(
			await db("client_searchee")
				.where({ client_host: "restart-active", info_hash: "fresh" })
				.first(),
		).toBeDefined();
		expect(getHealthGeneration()).toBe(before + 1);
	});

	it("merges preexisting same-client origins only after authoritative alias metadata arrives", async () => {
		await upsertSearcheeClientDB([
			publicationFixture("hybrid-merge", "primary"),
			publicationFixture("hybrid-merge", "alternate"),
		]);
		await upsertSearcheeClientDB(
			[publicationFixture("hybrid-merge", "primary")],
			undefined,
			new Map([["primary", ["alternate"]]]),
		);
		const origins = await db("source_origin")
			.join("source_namespace", "namespace_id", "source_namespace.id")
			.where({ locator: "hybrid-merge" })
			.whereNot("state", "superseded")
			.count({ n: "*" })
			.first();
		expect(origins).toMatchObject({ n: 1 });
	});

	it("retains persisted alias ordering when the coordinator restarts and remote aliases are omitted", async () => {
		const { beginClientCacheOperation, restartClientCachePublication } =
			await import("../src/clientCachePublication.js");
		await upsertSearcheeClientDB(
			[publicationFixture("persisted-alias", "primary")],
			undefined,
			new Map([["primary", ["alternate"]]]),
		);
		restartClientCachePublication();
		const old = beginClientCacheOperation("persisted-alias");
		await upsertSearcheeClientDB([
			{
				...publicationFixture("persisted-alias", "primary"),
				savePath: "/new",
			},
		]);
		expect(
			await upsertSearcheeClientDB(
				[
					{
						...publicationFixture("persisted-alias", "alternate"),
						savePath: "/old",
					},
				],
				old,
			),
		).toBe(false);
	});

	it("orders authoritative aliases as one origin across different primary keys", async () => {
		const { beginClientCacheOperation } =
			await import("../src/clientCachePublication.js");
		const old = beginClientCacheOperation("alias-order");
		const aliases = new Map([
			["primary", ["primary", "alternate"]],
			["alternate", ["primary", "alternate"]],
		]);
		await upsertSearcheeClientDB(
			[
				{
					...publicationFixture("alias-order", "primary"),
					savePath: "/new",
				},
			],
			undefined,
			aliases,
		);
		expect(
			await upsertSearcheeClientDB(
				[
					{
						...publicationFixture("alias-order", "alternate"),
						savePath: "/old",
					},
				],
				old,
				aliases,
			),
		).toBe(false);
		const origin = await db<{
			metadata: string;
			state: string;
			source_key: string;
		}>("source_origin")
			.join("source_namespace", "namespace_id", "source_namespace.id")
			.where({ locator: "alias-order" })
			.first<{ metadata: string }>("metadata");
		expect(JSON.parse(origin.metadata) as unknown).toMatchObject({
			savePath: "/new",
		});
	});
	it("retains an origin whose authoritative alias is present in a complete snapshot", async () => {
		const aliases = new Map([
			["primary", ["primary", "alternate"]],
			["alternate", ["primary", "alternate"]],
		]);
		await upsertSearcheeClientDB(
			[publicationFixture("alias-seen", "alternate")],
			undefined,
			aliases,
		);
		await updateSearcheeClientDB(
			"alias-seen",
			[publicationFixture("alias-seen", "primary")],
			new Set(["primary"]),
			undefined,
			true,
			aliases,
		);
		const origin = await db<{
			metadata: string;
			state: string;
			source_key: string;
		}>("source_origin")
			.join("source_namespace", "namespace_id", "source_namespace.id")
			.where({ locator: "alias-seen" })
			.first<{ state: string }>("state");
		expect(origin.state).toBe("verified");
	});

	it("keeps newer scoped additions and tombstones when a complete snapshot is superseded", async () => {
		const { beginClientCacheOperation } =
			await import("../src/clientCachePublication.js");
		const old = beginClientCacheOperation("ordered");
		await upsertSearcheeClientDB([publicationFixture("ordered", "new")]);
		await updateSearcheeClientDB("ordered", [], new Set(), old);
		expect(
			await db("client_searchee")
				.where({ client_host: "ordered", info_hash: "new" })
				.first(),
		).toBeDefined();
		const stale = beginClientCacheOperation("ordered");
		await updateSearcheeClientDB("ordered", [], new Set());
		expect(
			await upsertSearcheeClientDB(
				[publicationFixture("ordered", "new")],
				stale,
			),
		).toBe(false);
		expect(
			await db("client_searchee")
				.where({ client_host: "ordered", info_hash: "new" })
				.first(),
		).toBeUndefined();
	});
	it("rejects old coordinator session responses after restart", async () => {
		const { beginClientCacheOperation, restartClientCachePublication } =
			await import("../src/clientCachePublication.js");
		const stale = beginClientCacheOperation("restart");
		restartClientCachePublication();
		expect(
			await upsertSearcheeClientDB(
				[publicationFixture("restart", "late")],
				stale,
			),
		).toBe(false);
		await updateSearcheeClientDB(
			"restart",
			[publicationFixture("restart", "fresh")],
			new Set(["fresh"]),
		);
		await updateSearcheeClientDB("restart", [], new Set(), stale);
		expect(
			await db("client_searchee")
				.where({ client_host: "restart", info_hash: "fresh" })
				.first(),
		).toBeDefined();
	});
	it("tombstones only the removed source during complete reconciliation", async () => {
		await upsertSearcheeClientDB([
			publicationFixture("tombstones", "gone"),
			publicationFixture("tombstones", "keep"),
		]);
		await updateSearcheeClientDB("tombstones", [], new Set(["keep"]));
		const origins = await db<{
			metadata: string;
			state: string;
			source_key: string;
		}>("source_origin")
			.join("source_namespace", "namespace_id", "source_namespace.id")
			.where({ locator: "tombstones" })
			.select("source_key", "state")
			.orderBy("source_key");
		expect(origins).toEqual([
			{ source_key: "gone", state: "removed" },
			{ source_key: "keep", state: "verified" },
		]);
	});
	it("rolls back metadata removals if a membership deletion fails", async () => {
		await upsertSearcheeClientDB([
			publicationFixture("atomic-delete", "retained"),
		]);
		await db("ensemble").insert({
			client_host: "atomic-delete",
			info_hash: "retained",
			path: "/fixture/file",
			ensemble: "fixture",
			element: "1",
		});
		await db.raw(
			`CREATE TRIGGER fail_membership_delete BEFORE DELETE ON ensemble WHEN OLD.client_host = 'atomic-delete' BEGIN SELECT RAISE(ABORT, 'membership delete failure'); END`,
		);
		const before = getHealthGeneration();
		try {
			await expect(
				updateSearcheeClientDB("atomic-delete", [], new Set()),
			).rejects.toThrow("membership delete failure");
			expect(
				await db("client_searchee")
					.where({
						client_host: "atomic-delete",
						info_hash: "retained",
					})
					.first(),
			).toBeDefined();
			expect(getHealthGeneration()).toBe(before);
		} finally {
			await db.raw("DROP TRIGGER fail_membership_delete");
		}
	});

	it("publishes source metadata and episode memberships together", async () => {
		const { setRuntimeConfig } = await import("../src/runtimeConfig.js");
		const { getDefaultRuntimeConfig } =
			await import("../src/configuration.js");
		setRuntimeConfig({
			...getDefaultRuntimeConfig(),
			seasonFromEpisodes: 1,
		});
		const source = {
			...publicationFixture("ownership", "episode"),
			title: "Fixture.S01E01",
			name: "Fixture.S01E01",
		};
		await upsertSearcheeClientDB([source]);
		const origins = await db<{
			metadata: string;
			state: string;
			source_key: string;
		}>("source_origin")
			.join("source_namespace", "namespace_id", "source_namespace.id")
			.where({ locator: "ownership" })
			.select<{ metadata: string }[]>("source_origin.metadata");
		expect(origins).toHaveLength(1);
		expect(JSON.parse(origins[0].metadata)).toMatchObject({
			savePath: "/fixture",
		});
		const members = await db("ensemble_membership")
			.join("physical_path", "path_id", "physical_path.id")
			.select("path", "element");
		expect(members).toContainEqual({
			path: "/fixture/file",
			element: "1.0",
		});
	});

	it("invalidates health for a committed batch even if a later SQL batch fails", async () => {
		const values = Array.from({ length: 101 }, (_, i) =>
			publicationFixture("late-failure", String(i)),
		);
		await db.raw(
			`CREATE TRIGGER fail_cache_batch BEFORE INSERT ON client_searchee WHEN NEW.client_host = 'late-failure' AND NEW.info_hash = '100' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`,
		);
		const before = getHealthGeneration();
		try {
			await expect(upsertSearcheeClientDB(values)).rejects.toThrow(
				"fixture failure",
			);
			expect(
				await db("client_searchee")
					.where("client_host", "late-failure")
					.count({ n: "*" })
					.first(),
			).toMatchObject({ n: 100 });
			expect(getHealthGeneration()).toBeGreaterThan(before);
		} finally {
			await db.raw("DROP TRIGGER fail_cache_batch");
		}
	});
	it("does not perform complete removals when metadata publication fails", async () => {
		await upsertSearcheeClientDB([
			publicationFixture("failed-snapshot", "retained"),
		]);
		await db.raw(
			`CREATE TRIGGER fail_snapshot BEFORE INSERT ON client_searchee WHEN NEW.client_host = 'failed-snapshot' AND NEW.info_hash = 'fail' BEGIN SELECT RAISE(ABORT, 'snapshot failure'); END`,
		);
		try {
			await expect(
				updateSearcheeClientDB(
					"failed-snapshot",
					[publicationFixture("failed-snapshot", "fail")],
					new Set(["fail"]),
				),
			).rejects.toThrow("snapshot failure");
			expect(
				await db("client_searchee")
					.where({
						client_host: "failed-snapshot",
						info_hash: "retained",
					})
					.first(),
			).toBeDefined();
		} finally {
			await db.raw("DROP TRIGGER fail_snapshot");
		}
	});
});

afterAll(async () => {
	await db.destroy();
	await rm(root, { recursive: true, force: true });
});
