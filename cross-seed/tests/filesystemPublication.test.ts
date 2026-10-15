import {
	mkdtemp,
	mkdir,
	rm,
	writeFile,
	stat,
	readFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TorrentClient } from "../src/clients/TorrentClient.js";
import type { SearcheeWithInfoHash } from "../src/searchee.js";
import { beforeEach, afterEach, it, expect, vi } from "vitest";

const gates = vi.hoisted(() => ({
	catalogRoot: "",
	catalogCaptured: undefined as (() => void) | undefined,
	catalogRelease: undefined as Promise<void> | undefined,
}));
vi.mock("fs/promises", async (original) => {
	const actual = await original<typeof import("fs/promises")>();
	return {
		...actual,
		readdir: async (...args: Parameters<typeof actual.readdir>) => {
			const captured = await actual.readdir(...args);
			if (String(args[0]) === gates.catalogRoot && gates.catalogRelease) {
				const release = gates.catalogRelease;
				gates.catalogRelease = undefined;
				gates.catalogCaptured?.();
				await release;
			}
			return captured;
		},
	};
});
let root: string, dir: string, media: string;
let db: typeof import("../src/db.js").db;
let fixtureClient: TorrentClient;
let detailGate: Promise<void> | undefined;
let detailCaptured: (() => void) | undefined;
let placement: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "source-fs-"));
	dir = join(root, "torrents");
	media = join(root, "media");
	await mkdir(dir);
	await mkdir(media);
	process.env.CONFIG_DIR = root;
	vi.resetModules();
	({ db } = await import("../src/db.js"));
	const { createAppDirHierarchy, getDefaultRuntimeConfig } =
		await import("../src/configuration.js");
	createAppDirHierarchy();
	const { initializeLogger, Label } = await import("../src/logger.js");
	initializeLogger({ verbose: false });
	const { setRuntimeConfig } = await import("../src/runtimeConfig.js");
	setRuntimeConfig({
		...getDefaultRuntimeConfig(),
		torrentDir: dir,
		useClientTorrents: false,
		seasonFromEpisodes: 1,
	});
	await db.migrate.latest();
	const { resultOf, resultOfErr } = await import("../src/Result.js");
	const { InjectionResult } = await import("../src/constants.js");
	placement = media;
	detailGate = undefined;
	detailCaptured = undefined;
	fixtureClient = {
		clientHost: "fixture",
		clientType: Label.QBITTORRENT,
		clientPriority: 0,
		label: "Fixture",
		readonly: false,
		getAllDownloadDirs: async ({
			metas,
		}: {
			metas: SearcheeWithInfoHash[];
		}) => {
			const captured = placement;
			if (detailGate) {
				const gate = detailGate;
				detailGate = undefined;
				detailCaptured?.();
				await gate;
			}
			return new Map(metas.map((meta) => [meta.infoHash, captured]));
		},
		getDownloadDir: (meta: { name: string }) =>
			Promise.resolve(
				meta.name.startsWith("Review.Show")
					? resultOf(media)
					: resultOfErr("NOT_FOUND" as const),
			),
		isTorrentInClient: () => Promise.resolve(resultOf(false)),
		isTorrentComplete: () => Promise.resolve(resultOf(true)),
		inject: () => Promise.resolve(InjectionResult.SUCCESS),
		getAllTorrents: () => Promise.resolve([]),
	} as unknown as TorrentClient;
	const { setClientsForTesting } =
		await import("../src/clients/TorrentClient.js");
	setClientsForTesting([fixtureClient]);
	gates.catalogRoot = dir;
	gates.catalogCaptured = undefined;
	gates.catalogRelease = undefined;
});
afterEach(async () => {
	gates.catalogRelease = undefined;
	const { resetClientsForTesting } =
		await import("../src/clients/TorrentClient.js");
	resetClientsForTesting();
	await db.destroy();
	await rm(root, { recursive: true, force: true });
});
async function addTorrent(episode: number) {
	const { Metafile } = await import("../src/parseTorrent.js");
	const name = `Review.Show.S01E0${episode}.mkv`;
	const meta = new Metafile({
		info: {
			name: Buffer.from(name),
			length: 100,
			private: 1,
			"piece length": 16384,
			pieces: Buffer.alloc(20, episode),
		},
	});
	const path = join(dir, `${episode}.torrent`);
	await writeFile(path, new Uint8Array(meta.encode()));
	await writeFile(join(media, name), Buffer.alloc(100, episode));
	return { path, meta };
}

it("keeps .torrent provenance separate from media paths through actual hardlink injection", async () => {
	const { path } = await addTorrent(1);
	const { loadTorrentDirLight } = await import("../src/torrent.js");
	const [source] = await loadTorrentDirLight(dir);

	const { setRuntimeConfig } = await import("../src/runtimeConfig.js");
	const { getDefaultRuntimeConfig } = await import("../src/configuration.js");
	const { Action, Decision, LinkType, InjectionResult } =
		await import("../src/constants.js");
	const links = join(root, "links");
	await mkdir(links);
	setRuntimeConfig({
		...getDefaultRuntimeConfig(),
		torrentDir: dir,
		action: Action.INJECT,
		linkDirs: [links],
		linkType: LinkType.HARDLINK,
		flatLinking: true,
		outputDir: root,
	});
	const { Metafile } = await import("../src/parseTorrent.js");
	const candidate = new Metafile({
		info: {
			name: Buffer.from("renamed.mkv"),
			length: 100,
			private: 1,
			"piece length": 16384,
			pieces: Buffer.alloc(20, 2),
		},
	});
	const { Label } = await import("../src/logger.js");
	const { performActionWithoutMutex } = await import("../src/action.js");
	const result = await performActionWithoutMutex(
		candidate,
		Decision.MATCH_SIZE_ONLY,
		{ ...source, label: Label.INJECT },
		"fixture",
		fixtureClient,
		{ onlyCompleted: false },
	);
	expect(result.actionResult).toBe(InjectionResult.SUCCESS);
	expect(await readFile(join(links, "renamed.mkv"))).toEqual(
		Buffer.alloc(100, 1),
	);
	expect((await stat(join(links, "renamed.mkv"))).ino).toBe(
		(await stat(join(media, source.files[0].path))).ino,
	);
	expect(source.path).toBeUndefined();
	expect(source.torrentFilePath).toBe(path);
});

it.each(["newer-first", "older-first"] as const)(
	"orders gated torrent catalog and newer watcher publication: %s",
	async (order) => {
		await addTorrent(1);
		const { refreshTorrentDirectory } = await import("../src/torrent.js");
		let releaseCatalog!: () => void;
		let captured!: () => void;
		gates.catalogRelease = new Promise<void>((r) => {
			releaseCatalog = r;
		});
		const catalogCaptured = new Promise<void>((r) => {
			captured = r;
		});
		gates.catalogCaptured = captured;
		const older = refreshTorrentDirectory(dir);
		await catalogCaptured;
		await addTorrent(2);
		let releaseDetail!: () => void;
		let detailStarted!: () => void;
		let detailEntered: Promise<void> | undefined;
		if (order === "older-first") {
			detailGate = new Promise<void>((r) => {
				releaseDetail = r;
			});
			detailEntered = new Promise<void>((r) => {
				detailStarted = r;
			});
			detailCaptured = detailStarted;
		}
		const newer = refreshTorrentDirectory(dir);
		if (order === "newer-first") {
			expect(await newer).toBe(true);
			releaseCatalog();
			await older;
		} else {
			await detailEntered;
			releaseCatalog();
			expect(await older).toBe(true);
			releaseDetail();
			expect(await newer).toBe(true);
		}
		expect(
			await db("ensemble_membership").count({ n: "*" }).first(),
		).toEqual({ n: 2 });
		expect(
			(await db<{ file_path: string }>("torrent").select("file_path"))
				.map((row) => row.file_path)
				.sort(),
		).toEqual([join(dir, "1.torrent"), join(dir, "2.torrent")]);
		const { getClientCachePublicationStats } =
			await import("../src/clientCachePublication.js");
		expect(getClientCachePublicationStats().activeLeases).toBe(0);
	},
);

it("retains source and compatibility torrent metadata when a mounted root appears empty", async () => {
	const { path } = await addTorrent(1);
	const { refreshTorrentDirectory } = await import("../src/torrent.js");
	expect(await refreshTorrentDirectory(dir)).toBe(true);
	await rm(path);
	expect(await refreshTorrentDirectory(dir)).toBe(false);
	expect(await db("torrent").count({ n: "*" }).first()).toEqual({ n: 1 });
	expect(await db("ensemble_membership").count({ n: "*" }).first()).toEqual({
		n: 1,
	});
});

it("hides disabled cached client and data sources without deleting compatibility rows", async () => {
	const { setRuntimeConfig } = await import("../src/runtimeConfig.js");
	const { getDefaultRuntimeConfig } = await import("../src/configuration.js");
	setRuntimeConfig({
		...getDefaultRuntimeConfig(),
		dataDirs: [media],
		useClientTorrents: true,
		seasonFromEpisodes: 1,
	});
	const { path, meta } = await addTorrent(1);
	void path;
	const { upsertSearcheeClientDB } = await import("../src/searchee.js");
	const source = {
		infoHash: meta.infoHash,
		name: meta.name,
		title: meta.name,
		files: meta.files,
		length: 100,
		clientHost: "fixture",
		savePath: media,
		trackers: [],
	};
	await upsertSearcheeClientDB([source]);
	const { indexDataPaths, getDataByFuzzyName } =
		await import("../src/dataFiles.js");
	const dataPath = join(media, meta.name);
	await indexDataPaths([dataPath]);
	const { getSimilarByName, getInfoHashesToExclude } =
		await import("../src/torrent.js");
	expect((await getSimilarByName(meta.name)).clientSearchees).toHaveLength(1);
	expect(await getDataByFuzzyName(meta.name)).toHaveLength(1);
	expect(await getInfoHashesToExclude()).toEqual(new Set([meta.infoHash]));
	await db("source_namespace")
		.whereIn("type", ["client", "data-root"])
		.update({ enabled: 0 });
	expect((await getSimilarByName(meta.name)).clientSearchees).toEqual([]);
	expect((await getSimilarByName(meta.name)).dataSearchees).toEqual([]);
	expect(await getDataByFuzzyName(meta.name)).toEqual([]);
	expect(await getInfoHashesToExclude()).toEqual(new Set());
	expect(await db("client_searchee").count({ n: "*" }).first()).toEqual({
		n: 1,
	});
	expect(await db("data").count({ n: "*" }).first()).toEqual({ n: 1 });
	await db("source_namespace")
		.whereIn("type", ["client", "data-root"])
		.update({ enabled: 1 });
	expect((await getSimilarByName(meta.name)).clientSearchees).toHaveLength(1);
	expect(await getDataByFuzzyName(meta.name)).toHaveLength(1);
	expect(await getInfoHashesToExclude()).toEqual(new Set([meta.infoHash]));
	const { bindClientSourceLocator } = await import("../src/sourceStore.js");
	bindClientSourceLocator("fixture", "https://other-endpoint/qb");
	expect((await getSimilarByName(meta.name)).clientSearchees).toEqual([]);
	expect(await getInfoHashesToExclude()).toEqual(new Set());
	expect(await db("client_searchee").count({ n: "*" }).first()).toEqual({
		n: 1,
	});
});

it("reconciles live configuration visibility while retaining disabled source state for recovery", async () => {
	const { setRuntimeConfig } = await import("../src/runtimeConfig.js");
	const { getDefaultRuntimeConfig } = await import("../src/configuration.js");
	setRuntimeConfig({
		...getDefaultRuntimeConfig(),
		dataDirs: [media],
		useClientTorrents: true,
		seasonFromEpisodes: 1,
	});
	const { meta } = await addTorrent(1);
	const { upsertSearcheeClientDB } = await import("../src/searchee.js");
	await upsertSearcheeClientDB([
		{
			infoHash: meta.infoHash,
			name: meta.name,
			title: meta.name,
			files: meta.files,
			length: 100,
			clientHost: "fixture",
			savePath: media,
			trackers: [],
		},
	]);
	const { indexDataPaths } = await import("../src/dataFiles.js");
	await indexDataPaths([join(media, meta.name)]);
	const { sourceMembershipQuery } = await import("../src/sourceStore.js");
	expect(await sourceMembershipQuery(db)).toHaveLength(2);
	const { reconcileSourceNamespaces } = await import("../src/torrent.js");
	setRuntimeConfig({
		...getDefaultRuntimeConfig(),
		dataDirs: [],
		useClientTorrents: false,
	});
	await reconcileSourceNamespaces();
	expect(await sourceMembershipQuery(db)).toEqual([]);
	expect(
		await db("source_origin")
			.where({ state: "verified" })
			.count({ n: "*" })
			.first(),
	).toEqual({ n: 2 });
	expect(await db("ensemble_membership").count({ n: "*" }).first()).toEqual({
		n: 2,
	});
	setRuntimeConfig({
		...getDefaultRuntimeConfig(),
		dataDirs: [media],
		useClientTorrents: true,
	});
	await reconcileSourceNamespaces();
	expect(await sourceMembershipQuery(db)).toHaveLength(1);
	expect(await db("ensemble_membership").count({ n: "*" }).first()).toEqual({
		n: 2,
	});
	await upsertSearcheeClientDB([
		{
			infoHash: meta.infoHash,
			name: meta.name,
			title: meta.name,
			files: meta.files,
			length: 100,
			clientHost: "fixture",
			savePath: media,
			trackers: [],
		},
	]);
	expect(await sourceMembershipQuery(db)).toHaveLength(2);
});
