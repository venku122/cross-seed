// Compiled correctness smoke with disposable SQLite/files and guarded synthetic qB transport.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
const repo = resolve(process.argv[2] ?? ".");
const root = await fs.mkdtemp(join(tmpdir(), "integration-runtime-"));
process.env.CONFIG_DIR = root;
const load = (name) =>
	import(pathToFileURL(join(repo, "cross-seed/dist", `${name}.js`)).href);
const sourceA = join(root, "source-a");
const sourceB = join(root, "source-b");
const links = join(root, "links");
for (const dir of [sourceA, sourceB, links, join(root, "cross-seeds")])
	await fs.mkdir(dir);
const catalog = Array.from({ length: 3 }, (_, i) => ({
	hash: i.toString(16).padStart(40, "0"),
	infohash_v1: i.toString(16).padStart(40, "0"),
	name: "Runtime Fixture S01E01.mkv",
	save_path: sourceA,
	category: "fixture",
	tags: "fixture",
	total_size: 7,
	files: [
		{ name: `media-${i}.mkv`, size: 7, progress: 1, index: 0, priority: 1 },
	],
	trackers: [],
}));
for (const torrent of catalog)
	await fs.writeFile(join(sourceA, torrent.files[0].name), "fixture");
await fs.writeFile(join(sourceB, "media-0.mkv"), "fixture");
const originalFetch = globalThis.fetch;
let versionStatus = 200;
const routes = {};
globalThis.fetch = async (url, options = {}) => {
	const parsed = new URL(String(url));
	if (parsed.hostname !== "qb-fixture.invalid") {
		if (
			parsed.hostname === "127.0.0.1" &&
			["/api/ping", "/settings/health"].includes(parsed.pathname)
		)
			return originalFetch(url, options);
		throw new Error("Unexpected external transport");
	}
	const route = parsed.pathname.replace("/api/v2", "");
	routes[route] = (routes[route] ?? 0) + 1;
	let body;
	if (route === "/auth/login") body = "Ok.";
	else if (route === "/app/version")
		return new Response("v5.1.0", { status: versionStatus });
	else if (route === "/torrents/info") {
		const params = new URLSearchParams(options.body);
		const hashes = params.get("hashes");
		const selected = hashes
			? catalog.filter((torrent) => torrent.hash === hashes)
			: catalog;
		body = JSON.stringify(
			params.get("includeFiles") === "true"
				? selected
				: selected.map(({ files, trackers, ...torrent }) => torrent),
		);
	} else throw new Error(`Unexpected qB fixture endpoint ${route}`);
	return new Response(body, {
		status: 200,
		headers: { "Set-Cookie": "SID=fixture" },
	});
};
const { db } = await load("db");
let app;
try {
	const { createAppDirHierarchy, getDefaultRuntimeConfig } =
		await load("configuration");
	const { setRuntimeConfig } = await load("runtimeConfig");
	const loggerModule = await load("logger");
	const { setClientsForTesting } = await load("clients/TorrentClient");
	const { default: QBittorrent } = await load("clients/QBittorrent");
	const { healthRouter } = await load("trpc/routers/health");
	const { writeEnsembleTorrentEntries } = await load("ensembleWriter");
	const { cacheEnsembleTorrentEntry } = await load("torrent");
	createAppDirHierarchy();
	loggerModule.initializeLogger({ verbose: false });
	loggerModule.logger.silent = true;
	await db.migrate.latest();
	assert.equal(
		(
			await db.raw(
				"SELECT name FROM sqlite_master WHERE type='index' AND name='ensemble_key_index'",
			)
		).length,
		1,
	);
	setRuntimeConfig({
		...getDefaultRuntimeConfig(),
		torrentClients: ["qbittorrent:http://qb-fixture.invalid"],
		torrentDir: undefined,
		dataDirs: [],
		linkDirs: [links],
		outputDir: join(root, "cross-seeds"),
	});
	const client = new QBittorrent(
		"http://qb-fixture.invalid",
		"fixture",
		0,
		false,
	);
	await client.login(true);
	setClientsForTesting([client]);
	await client.getClientSearchees({
		refresh: [],
		includeFiles: true,
		includeTrackers: true,
	});
	for (const key of Object.keys(routes)) delete routes[key];
	const caller = healthRouter.createCaller({
		user: { id: 1, username: "fixture" },
	});
	const snapshots = await Promise.all(
		Array.from({ length: 10 }, () => caller.get()),
	);
	assert.equal(routes["/app/version"], 1);
	assert.equal(routes["/torrents/info"], 1);
	assert.ok(
		snapshots.every(
			(value) => value.measuredAt === snapshots[0].measuredAt,
		),
	);
	assert.ok(
		!snapshots[0].problems.some((problem) =>
			problem.id.startsWith("client:"),
		),
	);
	const oldSnapshot = snapshots[0];
	catalog[0].save_path = sourceB;
	const refreshed = await client.refreshOne(catalog[0].hash);
	assert.equal(refreshed.savePath, sourceB);
	const cache = await db("client_searchee")
		.where("client_host", "fixture")
		.orderBy("info_hash");
	assert.equal(cache.length, 3);
	assert.equal(cache[0].save_path, sourceB);
	assert.ok(cache.slice(1).every((row) => row.save_path === sourceA));
	const beforeVersion = routes["/app/version"];
	await caller.get();
	assert.equal(
		routes["/app/version"],
		beforeVersion + 1,
		"scoped metadata invalidates cached health",
	);
	const beforeForced = routes["/app/version"];
	await Promise.all(Array.from({ length: 10 }, () => caller.refresh()));
	assert.equal(
		routes["/app/version"],
		beforeForced + 1,
		"manual force bypasses TTL and coalesces",
	);
	const freshSources = (
		await client.getClientSearchees({
			includeFiles: true,
			includeTrackers: true,
		})
	).searchees;
	await writeEnsembleTorrentEntries(freshSources, cacheEnsembleTorrentEntry);
	const memberships = await db("ensemble").select("*").orderByRaw("rowid");
	assert.equal(memberships.length, 3);
	await assert.rejects(
		writeEnsembleTorrentEntries(freshSources, async () => {
			throw new Error("fixture generation failure");
		}),
		/fixture generation failure/,
	);
	assert.deepEqual(
		await db("ensemble").select("*").orderByRaw("rowid"),
		memberships,
	);
	assert.equal(
		(
			await db.raw(
				"SELECT name FROM sqlite_temp_master WHERE name LIKE 'ensemble_stage_%'",
			)
		).length,
		0,
	);
	const originalFile = join(sourceA, "media-0.mkv");
	const linkedFile = join(links, "hardlink-smoke.mkv");
	await fs.link(originalFile, linkedFile);
	assert.equal(
		(await fs.stat(originalFile)).ino,
		(await fs.stat(linkedFile)).ino,
	);
	assert.equal((await fs.stat(originalFile)).nlink, 2);
	await fs.unlink(linkedFile);
	assert.equal((await fs.stat(originalFile)).nlink, 1);
	assert.equal(await fs.readFile(originalFile, "utf8"), "fixture");
	assert.deepEqual(await fs.readdir(links), []);
	versionStatus = 403;
	const forbidden = new QBittorrent(
		"http://qb-fixture.invalid",
		"forbidden",
		1,
		false,
	);
	await assert.rejects(
		forbidden.validateConfig({ healthOnly: true }),
		/failed with code 403/,
	);
	versionStatus = 200;
	forbidden.cookie = "";
	await forbidden.validateConfig({ healthOnly: true });
	const { staticFrontendPlugin } = await load("routes/staticFrontendPlugin");
	const { baseApiPlugin } = await load("routes/baseApi");
	const require = createRequire(join(repo, "package.json"));
	app = require("fastify")({ logger: false });
	await app.register(baseApiPlugin, { prefix: "/api" });
	await app.register(staticFrontendPlugin, { basePath: "" });
	await app.listen({ port: 0, host: "127.0.0.1" });
	const address = `http://127.0.0.1:${app.server.address().port}`;
	const ping = await fetch(`${address}/api/ping`);
	assert.equal(ping.status, 200);
	assert.equal(await ping.text(), "OK");
	const page = await fetch(`${address}/settings/health`, {
		headers: { Accept: "text/html" },
	});
	assert.equal(page.status, 200);
	const html = await page.text();
	assert.ok(html.includes("<html"));
	const rawHtml = await fs.readFile(
		join(repo, "cross-seed/dist/webui/index.html"),
		"utf8",
	);
	assert.equal(html, rawHtml.replaceAll("/__CROSS_SEED_BASE_PATH__", ""));
	assert.equal(
		(await db.raw("PRAGMA integrity_check"))[0].integrity_check,
		"ok",
	);
	console.log(
		`RUNTIME_SMOKE ${JSON.stringify({ success: true, node: process.version, platform: process.platform, arch: process.arch, cacheRows: cache.length, memberships: memberships.length, healthTabs: snapshots.length, measuredAt: oldSnapshot.measuredAt, scopedRetention: true, healthInvalidation: true, manualRefreshCoalescing: true, forbiddenHandshakeRecovery: true, stagedRollback: true, hardlinkInodeVerified: true, apiPing: true, assetFileSha256: createHash("sha256").update(rawHtml).digest("hex"), servedAssetSha256: createHash("sha256").update(html).digest("hex"), migrations: await db.migrate.currentVersion(), sqlite: await db.raw("SELECT sqlite_version() AS version") })}`,
	);
} finally {
	if (app) await app.close();
	await db.destroy();
	globalThis.fetch = originalFetch;
	await fs.rm(root, { recursive: true, force: true });
}
