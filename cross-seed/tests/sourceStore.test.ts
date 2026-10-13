import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Knex } from "knex";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let db: typeof import("../src/db.js").db;
let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "source-store-"));
	process.env.CONFIG_DIR = root;
	vi.resetModules();
	({ db } = await import("../src/db.js"));
	const { createAppDirHierarchy } = await import("../src/configuration.js");
	createAppDirHierarchy();
	const { initializeLogger } = await import("../src/logger.js");
	initializeLogger({ verbose: false });
	await db.migrate.latest();
});
afterEach(async () => {
	await db.destroy();
	await rm(root, { recursive: true, force: true });
});

it("migrates exact legacy tuples in first-row order without discarding the rollback table", async () => {
	const migration = (await import("../src/migrations/19-source-ownership.js"))
		.default;
	await db("ensemble").insert([
		{
			path: "/one",
			ensemble: "show",
			element: "1",
			client_host: null,
			info_hash: null,
		},
		{
			path: "/one",
			ensemble: "show",
			element: "1",
			client_host: null,
			info_hash: null,
		},
		{
			path: "/one",
			ensemble: "alias",
			element: "1",
			client_host: null,
			info_hash: null,
		},
	]);
	await migration.up(db);
	await migration.up(db);
	expect(
		await db("ensemble_membership")
			.orderBy("selection_order")
			.select("ensemble", "selection_order"),
	).toEqual([
		{ ensemble: "show", selection_order: 1 },
		{ ensemble: "alias", selection_order: 3 },
	]);
	expect(await db("ensemble").count({ n: "*" }).first()).toEqual({ n: 3 });
	expect(
		(await db<{
			id: string;
			state: string;
			metadata: string;
			revision: number;
		}>("source_origin").first())!.state,
	).toBe("legacy-unknown");
	await expect(migration.down(db)).rejects.toThrow(/preserved database/);
	expect(await db.schema.hasTable("ensemble_membership")).toBe(true);
});

it("keeps credentials out of identity and pathname and namespace type in identity", async () => {
	const { ensureSourceNamespace } = await import("../src/sourceStore.js");
	const a = await ensureSourceNamespace(
		db,
		"client",
		"https://user:secret@host/qb/",
	);
	expect(
		await ensureSourceNamespace(
			db,
			"client",
			"https://other:password@host/qb",
		),
	).toBe(a);
	expect(
		await ensureSourceNamespace(db, "client", "https://host/other"),
	).not.toBe(a);
	expect(
		(await db<{ id: string; locator: string; enabled: number }>(
			"source_namespace",
		)
			.where({ id: a })
			.first())!.locator,
	).toBe("https://host/qb");
	expect(
		await ensureSourceNamespace(db, "data-root", "https://host/qb"),
	).not.toBe(a);
});

it("keeps numeric legacy and newly generated episodes in the same element group", async () => {
	await db("ensemble").insert([
		{ path: "/legacy/episode", ensemble: "show.S1", element: 1 },
		{ path: "/legacy/literal", ensemble: "literal", element: "1" },
	]);
	const migration = (await import("../src/migrations/19-source-ownership.js"))
		.default;
	await migration.up(db);
	expect(await db("ensemble").orderBy("rowid").pluck("element")).toEqual([
		"1.0",
		"1",
	]);
	const { getDefaultRuntimeConfig } = await import("../src/configuration.js");
	const { setRuntimeConfig } = await import("../src/runtimeConfig.js");
	setRuntimeConfig({
		...getDefaultRuntimeConfig(),
		torrentDir: "/fixture/torrents",
	});
	const { writeEnsembleTorrentEntries } =
		await import("../src/ensembleWriter.js");
	await writeEnsembleTorrentEntries(
		[
			{
				infoHash: "new",
				name: "Show.S01E01",
				title: "Show.S01E01",
				length: 1,
				files: [{ name: "episode", path: "episode", length: 1 }],
				torrentFilePath: "/fixture/torrents/episode.torrent",
			},
		],
		() =>
			Promise.resolve([
				{
					client_host: null,
					info_hash: "new",
					path: "/new/episode",
					ensemble: "show.S1",
					element: 1,
				},
			]),
	);
	const { sourceMembershipQuery } = await import("../src/sourceStore.js");
	const mixed = await sourceMembershipQuery(db).where(
		"m.ensemble",
		"show.S1",
	);
	expect(mixed).toHaveLength(2);
	expect(new Set(mixed.map((row) => row.element))).toEqual(new Set(["1.0"]));
	expect(
		await db("ensemble_membership")
			.where("ensemble", "literal")
			.pluck("element"),
	).toEqual(["1"]);
});

it("retains numeric membership selection order while preserving literal string elements", async () => {
	const {
		ensureSourceNamespace,
		resolveSourceOrigin,
		replaceSourcePublication,
	} = await import("../src/sourceStore.js");
	const namespace = await ensureSourceNamespace(db, "data-root", "/fixture");
	const origin = await resolveSourceOrigin(db, namespace, "episode");
	await replaceSourcePublication(db, {
		originId: origin.id,
		expectedRevision: 0,
		revision: 1,
		status: "verified",
		metadata: {},
		memberships: [
			{
				path: "/episode",
				ensemble: "show.S1",
				element: "1.0",
				selectionOrder: 7,
			},
			{
				path: "/episode",
				ensemble: "show.S1",
				element: "1",
				selectionOrder: 9,
			},
		],
	});
	await replaceSourcePublication(db, {
		originId: origin.id,
		expectedRevision: 1,
		revision: 2,
		status: "verified",
		metadata: {},
		memberships: [
			{ path: "/episode", ensemble: "show.S1", element: 1 },
			{ path: "/episode", ensemble: "show.S1", element: "1" },
		],
	});
	expect(
		await db("ensemble_membership")
			.where("origin_id", origin.id)
			.orderBy("selection_order")
			.select("element", "selection_order"),
	).toEqual([
		{ element: "1.0", selection_order: 7 },
		{ element: "1", selection_order: 9 },
	]);
});

it("replaces only one owner atomically, resolves aliases per client, and rejects stale revisions", async () => {
	const {
		ensureSourceNamespace,
		resolveSourceOrigin,
		replaceSourcePublication,
	} = await import("../src/sourceStore.js");
	const ns = await ensureSourceNamespace(db, "client", "https://host/qb");
	const other = await ensureSourceNamespace(
		db,
		"client",
		"https://host/other",
	);
	const a = await resolveSourceOrigin(db, ns, "hash-v1", ["hash-v2"]);
	expect((await resolveSourceOrigin(db, ns, "hash-v2")).id).toBe(a.id);
	const b = await resolveSourceOrigin(db, other, "hash-v2");
	expect(b.id).not.toBe(a.id);
	const memberships = [{ path: "/same", ensemble: "show", element: "1" }];
	for (const origin of [a, b])
		expect(
			await replaceSourcePublication(db, {
				originId: origin.id,
				expectedRevision: 0,
				revision: 1,
				metadata: { title: origin.id },
				memberships,
				status: "verified",
			}),
		).toBe(true);
	expect(
		await replaceSourcePublication(db, {
			originId: a.id,
			expectedRevision: 0,
			revision: 2,
			metadata: { title: "stale" },
			memberships: [],
			status: "verified",
		}),
	).toBe(false);
	expect(
		await replaceSourcePublication(db, {
			originId: a.id,
			expectedRevision: 1,
			revision: 2,
			metadata: { title: "missing" },
			memberships: [],
			status: "unavailable",
		}),
	).toBe(false);
	expect(await db("ensemble_membership").count({ n: "*" }).first()).toEqual({
		n: 2,
	});
	expect(
		await replaceSourcePublication(db, {
			originId: a.id,
			expectedRevision: 1,
			revision: 2,
			metadata: { title: "empty" },
			memberships: [],
			status: "verified",
		}),
	).toBe(true);
	expect(await db("ensemble_membership").select("origin_id")).toEqual([
		{ origin_id: b.id },
	]);
	expect(
		JSON.parse(
			(await db<{
				id: string;
				state: string;
				metadata: string;
				revision: number;
			}>("source_origin")
				.where({ id: a.id })
				.first())!.metadata,
		),
	).toEqual({ title: "empty" });
});

it("rolls metadata and memberships back when insertion fails after deletion", async () => {
	const {
		ensureSourceNamespace,
		resolveSourceOrigin,
		replaceSourcePublication,
	} = await import("../src/sourceStore.js");
	const ns = await ensureSourceNamespace(db, "data-root", "/root");
	const origin = await resolveSourceOrigin(db, ns, "file");
	const publication = {
		originId: origin.id,
		expectedRevision: 0,
		revision: 1,
		metadata: { title: "old" },
		memberships: [{ path: "/old", ensemble: "show", element: "1" }],
		status: "verified" as const,
	};
	await replaceSourcePublication(db, publication);
	await db.raw(
		"CREATE TRIGGER fail_membership BEFORE INSERT ON ensemble_membership BEGIN SELECT RAISE(ABORT, 'injected'); END",
	);
	await expect(
		replaceSourcePublication(db, {
			...publication,
			expectedRevision: 1,
			revision: 2,
			metadata: { title: "new" },
			memberships: [{ path: "/new", ensemble: "show", element: "1" }],
		}),
	).rejects.toThrow("injected");
	expect(
		(await db<{
			id: string;
			state: string;
			metadata: string;
			revision: number;
		}>("source_origin")
			.where({ id: origin.id })
			.first())!.revision,
	).toBe(1);
	expect(
		await db("ensemble_membership")
			.join("physical_path", "path_id", "physical_path.id")
			.select("path"),
	).toEqual([{ path: "/old" }]);
});

it("keeps membership tie ordering and exact lexical paths across idempotent rebuilds", async () => {
	const {
		ensureSourceNamespace,
		resolveSourceOrigin,
		replaceSourcePublication,
	} = await import("../src/sourceStore.js");
	const ns = await ensureSourceNamespace(db, "data-root", "/root");
	const origin = await resolveSourceOrigin(db, ns, "show");
	const memberships = [
		{ path: "/A", ensemble: "show", element: "1" },
		{ path: "/a", ensemble: "show", element: "2" },
	];
	await replaceSourcePublication(db, {
		originId: origin.id,
		expectedRevision: 0,
		revision: 1,
		metadata: { title: "first" },
		memberships,
		status: "verified",
	});
	const before = await db("ensemble_membership").orderBy("selection_order");
	await replaceSourcePublication(db, {
		originId: origin.id,
		expectedRevision: 1,
		revision: 2,
		metadata: { title: "second" },
		memberships: memberships.toReversed(),
		status: "verified",
	});
	expect(await db("ensemble_membership").orderBy("selection_order")).toEqual(
		before,
	);
	expect(await db("physical_path").select("path").orderBy("path")).toEqual([
		{ path: "/A" },
		{ path: "/a" },
	]);
	await db.raw("PRAGMA foreign_keys = ON");
	await expect(
		db("source_alias").insert({
			namespace_id: "not-a-namespace",
			alias: "bad",
			origin_id: origin.id,
		}),
	).rejects.toThrow(/FOREIGN KEY/);
});

it("rolls interrupted migration import back and can restart without dropping legacy rows", async () => {
	const migration = (await import("../src/migrations/19-source-ownership.js"))
		.default;
	await db("ensemble").insert({
		path: "/kept",
		ensemble: "show",
		element: "1",
		client_host: null,
		info_hash: null,
	});
	await db.raw(
		"CREATE TRIGGER fail_import BEFORE INSERT ON ensemble_membership BEGIN SELECT RAISE(ABORT, 'interrupted'); END",
	);
	await expect(migration.up(db)).rejects.toThrow("interrupted");
	expect(
		await db<{
			id: string;
			state: string;
			metadata: string;
			revision: number;
		}>("source_origin")
			.count({ n: "*" })
			.first(),
	).toEqual({
		n: 0,
	});
	expect(await db("physical_path").count({ n: "*" }).first()).toEqual({
		n: 0,
	});
	expect(await db("ensemble").count({ n: "*" }).first()).toEqual({ n: 1 });
	await db.raw("DROP TRIGGER fail_import");
	await migration.up(db);
	expect(await db("ensemble_membership").count({ n: "*" }).first()).toEqual({
		n: 1,
	});
	expect(await db.raw("SELECT * FROM pragma_foreign_key_check")).toEqual([]);
});

it("does not merge conflicting authoritative aliases or null and empty legacy provenance", async () => {
	const { ensureSourceNamespace, resolveSourceOrigin } =
		await import("../src/sourceStore.js");
	const ns = await ensureSourceNamespace(db, "client", "https://host/qb");
	const a = await resolveSourceOrigin(db, ns, "one");
	await resolveSourceOrigin(db, ns, "two");
	await expect(resolveSourceOrigin(db, ns, "one", ["two"])).rejects.toThrow(
		/Conflicting/,
	);
	expect((await resolveSourceOrigin(db, ns, "one")).id).toBe(a.id);
	await db("ensemble").insert([
		{
			path: "/same",
			ensemble: "show",
			element: "1",
			client_host: null,
			info_hash: null,
		},
		{
			path: "/same",
			ensemble: "show",
			element: "1",
			client_host: "",
			info_hash: null,
		},
	]);
	await (
		await import("../src/migrations/19-source-ownership.js")
	).default.up(db);
	expect(
		await db<{
			id: string;
			state: string;
			metadata: string;
			revision: number;
		}>("source_origin")
			.where({ state: "legacy-unknown" })
			.count({ n: "*" })
			.first(),
	).toEqual({ n: 2 });
	expect(await db("ensemble_membership").count({ n: "*" }).first()).toEqual({
		n: 2,
	});
});

it("actual torrent writer preserves alternate titles and other owners across rebuilds and unavailable generation", async () => {
	const { writeEnsembleTorrentEntries } =
		await import("../src/ensembleWriter.js");
	const source = {
		infoHash: "hash",
		clientHost: "https://host/qb",
		savePath: "/same",
		name: "Show",
		title: "Show",
		length: 1,
		files: [{ name: "episode", path: "episode", length: 1 }],
	};
	const entries = [
		{
			client_host: source.clientHost,
			info_hash: "hash",
			path: "/same/episode",
			ensemble: "show",
			element: "1",
		},
		{
			client_host: source.clientHost,
			info_hash: "hash",
			path: "/same/episode",
			ensemble: "alternate",
			element: "1",
		},
	];
	await writeEnsembleTorrentEntries([source], () => Promise.resolve(entries));
	await writeEnsembleTorrentEntries([source], () => Promise.resolve(entries));
	expect(await db("ensemble_membership").count({ n: "*" }).first()).toEqual({
		n: 2,
	});
	await writeEnsembleTorrentEntries(
		[{ ...source, clientHost: "https://host/other" }],
		() =>
			Promise.resolve(
				entries.map((e) => ({
					...e,
					client_host: "https://host/other",
				})),
			),
	);
	await writeEnsembleTorrentEntries([source], () => Promise.resolve(null));
	expect(await db("ensemble_membership").count({ n: "*" }).first()).toEqual({
		n: 4,
	});
	const {
		resolveSourceOrigin,
		ensureSourceNamespace,
		replaceSourcePublication,
	} = await import("../src/sourceStore.js");
	const ns = await ensureSourceNamespace(db, "client", source.clientHost);
	const origin = await resolveSourceOrigin(db, ns, source.infoHash);
	await replaceSourcePublication(db, {
		originId: origin.id,
		expectedRevision: origin.revision,
		revision: origin.revision + 1,
		metadata: source,
		memberships: [],
		status: "verified",
	});
	expect(await db("ensemble_membership").count({ n: "*" }).first()).toEqual({
		n: 2,
	});
});

it("retires only exact known legacy client provenance on authoritative publication", async () => {
	const migration = (await import("../src/migrations/19-source-ownership.js"))
		.default;
	await db("ensemble").insert([
		{
			path: "/old",
			ensemble: "show",
			element: "1",
			client_host: "host/qb",
			info_hash: "h",
		},
		{
			path: "/unknown",
			ensemble: "show",
			element: "1",
			client_host: null,
			info_hash: "h",
		},
	]);
	await migration.up(db);
	const {
		ensureSourceNamespace,
		resolveSourceOrigin,
		replaceSourcePublication,
		sourceMembershipQuery,
	} = await import("../src/sourceStore.js");
	const ns = await ensureSourceNamespace(db, "client", "host/qb");
	const origin = await resolveSourceOrigin(db, ns, "h");
	await replaceSourcePublication(db, {
		originId: origin.id,
		expectedRevision: 0,
		revision: 1,
		metadata: { clientHost: "host/qb", infoHash: "h" },
		memberships: [{ path: "/new", ensemble: "show", element: "1" }],
		status: "verified",
	});
	expect((await sourceMembershipQuery(db)).map((r) => r.path).sort()).toEqual(
		["/new", "/unknown"],
	);
	expect(await db("ensemble").count({ n: "*" }).first()).toEqual({ n: 2 });
});

it("rejects tombstoning a source changed after a cleanup observation and hides disabled ownership", async () => {
	const {
		ensureSourceNamespace,
		resolveSourceOrigin,
		replaceSourcePublication,
		tombstoneSourceOrigin,
		sourceMembershipQuery,
	} = await import("../src/sourceStore.js");
	const ns = await ensureSourceNamespace(db, "data-root", "/root");
	const origin = await resolveSourceOrigin(db, ns, "file");
	await replaceSourcePublication(db, {
		originId: origin.id,
		expectedRevision: 0,
		revision: 1,
		metadata: { path: "/file" },
		memberships: [{ path: "/file", ensemble: "show", element: "1" }],
		status: "verified",
	});
	expect(await tombstoneSourceOrigin(db, origin.id, 0, 1)).toBe(false);
	expect(await sourceMembershipQuery(db)).toHaveLength(1);
	await db<{ id: string; locator: string; enabled: number }>(
		"source_namespace",
	)
		.where({ id: ns })
		.update({ enabled: 0 });
	expect(await sourceMembershipQuery(db)).toHaveLength(0);
	expect(await db("ensemble_membership").count({ n: "*" }).first()).toEqual({
		n: 1,
	});
	expect(await tombstoneSourceOrigin(db, origin.id, 1, 2)).toBe(true);
	expect(
		(await db<{
			id: string;
			state: string;
			metadata: string;
			revision: number;
		}>("source_origin")
			.where({ id: origin.id })
			.first())!.state,
	).toBe("removed");
});

it("a source changed while actual membership generation waits cannot be overwritten", async () => {
	const { writeEnsembleTorrentEntries } =
		await import("../src/ensembleWriter.js");
	const {
		ensureSourceNamespace,
		resolveSourceOrigin,
		replaceSourcePublication,
	} = await import("../src/sourceStore.js");
	const source = {
		infoHash: "hash",
		name: "Show",
		title: "Show",
		length: 1,
		files: [{ name: "episode", path: "episode", length: 1 }],
	};
	const ns = await ensureSourceNamespace(
		db,
		"torrent-directory",
		"unconfigured-torrent-directory",
	);
	const origin = await resolveSourceOrigin(db, ns, "hash");
	let release!: () => void;
	const pending = new Promise<void>((r) => {
		release = r;
	});
	let reached!: () => void;
	const started = new Promise<void>((r) => {
		reached = r;
	});
	const writer = writeEnsembleTorrentEntries([source], async () => {
		reached();
		await pending;
		return [
			{
				client_host: null,
				info_hash: "hash",
				path: "/old",
				ensemble: "show",
				element: "1",
			},
		];
	});
	await started;
	await replaceSourcePublication(db, {
		originId: origin.id,
		expectedRevision: 0,
		revision: 1,
		metadata: { ...source, savePath: "/new" },
		memberships: [{ path: "/new", ensemble: "show", element: "1" }],
		status: "verified",
	});
	release();
	await writer;
	expect(
		await db("ensemble_membership")
			.join("physical_path", "path_id", "physical_path.id")
			.select("path"),
	).toEqual([{ path: "/new" }]);
});

it("indexes overlapping data roots as separate owners and preserves state on unavailable paths", async () => {
	const { mkdir, writeFile } = await import("node:fs/promises");
	const nested = join(root, "nested");
	await mkdir(nested);
	const path = join(nested, "Review.Show.S01E01.mkv");
	await writeFile(path, "episode");
	const { setRuntimeConfig } = await import("../src/runtimeConfig.js");
	const { getDefaultRuntimeConfig } = await import("../src/configuration.js");
	setRuntimeConfig({
		...getDefaultRuntimeConfig(),
		dataDirs: [root, nested],
		seasonFromEpisodes: 1,
	});
	const { indexDataPaths } = await import("../src/dataFiles.js");
	await indexDataPaths([path]);
	await indexDataPaths([path]);
	expect(
		await db<{
			id: string;
			state: string;
			metadata: string;
			revision: number;
		}>("source_origin")
			.where({ state: "verified" })
			.count({ n: "*" })
			.first(),
	).toEqual({ n: 2 });
	expect(await db("ensemble_membership").count({ n: "*" }).first()).toEqual({
		n: 2,
	});
	await rm(path);
	await indexDataPaths([path]);
	expect(await db("ensemble_membership").count({ n: "*" }).first()).toEqual({
		n: 2,
	});
});

it("merges independently discovered aliases only after authoritative metadata establishes equivalence", async () => {
	const {
		ensureSourceNamespace,
		resolveSourceOrigin,
		replaceSourcePublication,
	} = await import("../src/sourceStore.js");
	const ns = await ensureSourceNamespace(db, "client", "host/qb");
	const a = await resolveSourceOrigin(db, ns, "v1");
	const b = await resolveSourceOrigin(db, ns, "v2");
	await replaceSourcePublication(db, {
		originId: a.id,
		expectedRevision: 0,
		revision: 1,
		metadata: { infoHash: "v1", savePath: "/old" },
		memberships: [{ path: "/old", ensemble: "show", element: "1" }],
		status: "verified",
	});
	await replaceSourcePublication(db, {
		originId: b.id,
		expectedRevision: 0,
		revision: 2,
		metadata: { infoHash: "v2", savePath: "/new" },
		memberships: [{ path: "/new", ensemble: "alias", element: "1" }],
		status: "verified",
	});
	await expect(resolveSourceOrigin(db, ns, "v1", ["v2"])).rejects.toThrow(
		/Conflicting/,
	);
	const merged = await resolveSourceOrigin(db, ns, "v1", ["v2"], {
		authoritativeAliases: true,
	});
	expect(merged.revision).toBe(2);
	expect(JSON.parse(merged.metadata)).toEqual({
		infoHash: "v2",
		savePath: "/new",
	});
	expect((await resolveSourceOrigin(db, ns, "v2")).id).toBe(merged.id);
	expect(
		await db("ensemble_membership")
			.where({ origin_id: merged.id })
			.count({ n: "*" })
			.first(),
	).toEqual({ n: 2 });
	const other = await ensureSourceNamespace(db, "client", "host/other");
	expect((await resolveSourceOrigin(db, other, "v2")).id).not.toBe(merged.id);
	await replaceSourcePublication(db, {
		originId: merged.id,
		expectedRevision: 2,
		revision: 3,
		metadata: { infoHash: "v1", savePath: "/final" },
		memberships: [{ path: "/final", ensemble: "show", element: "1" }],
		status: "verified",
	});
	expect(
		await db("ensemble_membership")
			.join("physical_path", "path_id", "physical_path.id")
			.where({ origin_id: merged.id })
			.select("path"),
	).toEqual([{ path: "/final" }]);
});

it("binds credentialless actual endpoint URLs while retaining host fallback for synthetic sources", async () => {
	const { bindClientSourceLocator, clientSourceLocator } =
		await import("../src/sourceStore.js");
	expect(clientSourceLocator("fixture")).toBe("fixture");
	bindClientSourceLocator(
		"host/qb",
		"https://user:secret@host//qb///?token=private#fragment",
	);
	expect(clientSourceLocator("host/qb")).toBe("https://host/qb");
	bindClientSourceLocator("host/qb", "http://host/qb");
	expect(clientSourceLocator("host/qb")).toBe("http://host/qb");
});

it("seeks compatibility paths by namespace rather than scanning its source metadata", async () => {
	const { getDefaultRuntimeConfig } = await import("../src/configuration.js");
	const { setRuntimeConfig } = await import("../src/runtimeConfig.js");
	const { enabledDataEntriesQuery } = await import("../src/dataFiles.js");
	const { getInfoHashesToExclude } = await import("../src/torrent.js");
	const {
		ensureSourceNamespace,
		resolveSourceOrigin,
		replaceSourcePublication,
	} = await import("../src/sourceStore.js");
	setRuntimeConfig({
		...getDefaultRuntimeConfig(),
		dataDirs: ["/fixture/data"],
		torrentDir: "/fixture/torrents",
		useClientTorrents: false,
	});
	for (const [type, rootPath, field] of [
		["data-root", "/fixture/data", "path"],
		["torrent-directory", "/fixture/torrents", "torrentFilePath"],
	] as const) {
		const namespace = await ensureSourceNamespace(db, type, rootPath);
		for (const [index, name] of ["001", "123", "space path"].entries()) {
			const path = `${rootPath}/${name}`;
			const origin = await resolveSourceOrigin(db, namespace, name);
			await replaceSourcePublication(db, {
				originId: origin.id,
				expectedRevision: 0,
				revision: 1,
				status: "verified",
				metadata: { [field]: path },
				memberships: [],
			});
			if (type === "data-root")
				await db("data").insert({ path, title: name });
			else
				await db("torrent").insert({
					file_path: path,
					info_hash: `hash-${index}`,
					name,
				});
		}
	}
	const dataQuery = enabledDataEntriesQuery().toSQL();
	const captured: { sql: string; bindings: Knex.RawBinding[] }[] = [];
	const capture = (query: { sql: string; bindings: Knex.RawBinding[] }) => {
		if (query.sql.includes("from `torrent` as `cache`"))
			captured.push(query);
	};
	db.on("query", capture);
	try {
		expect(await getInfoHashesToExclude()).toEqual(
			new Set(["hash-0", "hash-1", "hash-2"]),
		);
	} finally {
		db.off("query", capture);
	}
	expect(captured).toHaveLength(1);
	for (const [query, index, field] of [
		[dataQuery, "source_origin_data_path", "path"],
		[captured[0], "source_origin_torrent_path", "file_path"],
	] as const) {
		const plan = await db.raw<{ detail: string }[]>(
			`EXPLAIN QUERY PLAN ${query.sql}`,
			query.bindings,
		);
		const originPlans = plan.filter((row) => row.detail.includes("origin"));
		expect(originPlans).toHaveLength(2);
		for (const row of originPlans) {
			expect(row.detail).toContain(index);
			expect(row.detail).toContain("<expr>=?");
		}
		// Removing the outer column affinity preserves lexical string results.
		expect(await db.raw(query.sql, query.bindings)).toEqual(
			await db.raw(
				query.sql.replaceAll(`=+cache.${field}`, `=cache.${field}`),
				query.bindings,
			),
		);
	}
});
