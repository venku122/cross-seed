import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as pause } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repo = resolve(process.argv[2] ?? ".");
const count = Number(process.env.QB_COUNT ?? 8194);
const mode = process.env.QB_MODE ?? "baseline";
const fileCount = Number(process.env.QB_FILES ?? 1);
const modified = Number(process.env.QB_MODIFIED ?? 0);
const scenario = process.env.QB_SCENARIO ?? "normal";
const requestedHash =
	scenario === "alias" ? "2".repeat(64) : "1".padStart(40, "0");
const config = await mkdtemp(join(tmpdir(), "qb-targeted-"));
process.env.CONFIG_DIR = config;
const load = (file) =>
	import(pathToFileURL(join(repo, "cross-seed/dist", file)));
const { db } = await load("db.js");
const logging = await load("logger.js");
logging.initializeLogger({ verbose: false });
logging.logger.silent = true;
await db.migrate.latest();
const { default: QBittorrent } = await load("clients/QBittorrent.js");
const hash = (i) => i.toString(16).padStart(40, "0");
const torrents = Array.from({ length: count }, (_, i) => ({
	hash: hash(i + 1),
	infohash_v1: hash(i + 1),
	name: `Fixture.${i}`,
	save_path: "/fixture",
	content_path: "/fixture/file.mkv",
	category: "fixture",
	tags: "",
	tracker: "",
	total_size: 100,
}));
if (torrents[0]) {
	torrents[0].total_size = 100 * fileCount;
	torrents[0].infohash_v2 = "2".repeat(64);
}
const files = Array.from({ length: fileCount }, (_, i) => ({
	name: `file-${i}.mkv`,
	size: 100,
	progress: 1,
	index: i,
	priority: 1,
}));
for (let start = 0; start < count; start += 100) {
	await db("client_searchee").insert(
		torrents.slice(start, start + 100).map((t) => ({
			client_host: "fixture",
			info_hash: t.hash,
			name: t.name,
			title: t.name,
			files: JSON.stringify(
				t.hash === hash(1)
					? files.map((f) => ({
							name: f.name,
							path: f.name,
							length: f.size,
						}))
					: [{ name: "file.mkv", path: "file.mkv", length: 100 }],
			),
			length: t.total_size,
			save_path: t.save_path,
			category: t.category,
			tags: "[]",
			trackers: "[]",
		})),
	);
}
for (let i = 1; i <= modified && i < torrents.length; i++)
	torrents[i].name += ".Changed";
const untouchedDigest = async () =>
	createHash("sha256")
		.update(
			JSON.stringify(
				await db("client_searchee")
					.whereNot("info_hash", hash(1))
					.orderBy("info_hash"),
			),
		)
		.digest("hex");
const untouchedBefore = await untouchedDigest();
const requests = [];
let bytes = 0;
const server = createServer(async (req, res) => {
	let body = "";
	for await (const chunk of req) body += chunk;
	const params = new URLSearchParams(body);
	const route = req.url.replace("/api/v2", "");
	requests.push({ route, filtered: params.has("hashes") });
	if (
		(scenario === "api-error" && route === "/torrents/info") ||
		(scenario === "deleted-during-details" && route === "/torrents/files")
	) {
		res.statusCode = 400;
		res.end("fixture failure");
		return;
	}
	const value =
		route === "/torrents/info"
			? params.has("hashes")
				? torrents.filter(
						(t) =>
							t.hash === params.get("hashes") &&
							!(scenario === "absent" && t.hash === hash(1)),
					)
				: torrents.filter(
						(t) => !(scenario === "absent" && t.hash === hash(1)),
					)
			: route === "/torrents/files"
				? params.get("hash") === hash(1)
					? files
					: files.slice(0, 1)
				: [];
	const payload = JSON.stringify(value);
	bytes += Buffer.byteLength(payload);
	res.setHeader("content-type", "application/json");
	res.end(payload);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const client = new QBittorrent(
	`http://127.0.0.1:${server.address().port}`,
	"fixture",
	0,
	true,
);
let selects = 0;
const statements = { select: 0, insert: 0, update: 0, delete: 0, total: 0 };
const onQuery = (q) => {
	statements.total++;
	for (const kind of ["select", "insert", "update", "delete"])
		if (q.sql.startsWith(kind)) statements[kind]++;
	if (q.sql.startsWith("select") && q.sql.includes("client_searchee"))
		selects++;
};
db.on("query", onQuery);
const { default: Fastify } = await import(
	pathToFileURL(join(repo, "node_modules/fastify/fastify.js"))
);
const { baseApiPlugin } = await load("routes/baseApi.js");
const pingServer = Fastify({ logger: false });
pingServer.removeAllContentTypeParsers();
await pingServer.register(baseApiPlugin, { prefix: "/api" });
const pingOrigin = await pingServer.listen({ port: 0, host: "127.0.0.1" });
const pingUrl = `${pingOrigin}/api/ping`;
assert.equal(await (await fetch(pingUrl)).text(), "OK");
const pings = [];
let pinging = true;
const pingLoop = (async () => {
	while (pinging) {
		const start = performance.now();
		await (await fetch(pingUrl)).text();
		pings.push(performance.now() - start);
		await pause(1);
	}
})();
const loop = monitorEventLoopDelay({ resolution: 1 });
loop.enable();
await pause(10);
pings.length = 0;
loop.reset();
const cpuStart = process.cpuUsage(),
	memoryStart = process.memoryUsage(),
	eluStart = performance.eventLoopUtilization();
const start = performance.now();
let failure;
try {
	if (mode === "baseline")
		await client.getClientSearchees({
			newSearcheesOnly: true,
			refresh: [requestedHash],
		});
	else {
		let expectedFailure = false;
		try {
			const value = await client.refreshOne(requestedHash);
			if (scenario === "absent") assert.equal(value, undefined);
		} catch (error) {
			if (!["api-error", "deleted-during-details"].includes(scenario))
				throw error;
			expectedFailure = true;
		}
		if (["api-error", "deleted-during-details"].includes(scenario))
			assert.equal(expectedFailure, true, "API failures must reject");
	}
	const wallMs = performance.now() - start;
	const cpu = process.cpuUsage(cpuStart),
		memory = process.memoryUsage();
	await pause(10);
	pinging = false;
	await pingLoop;
	loop.disable();
	db.removeListener("query", onQuery);
	const rows = await db("client_searchee").count({ count: "*" }).first();
	const percentile = (a, q) =>
		a.length
			? a.toSorted((x, y) => x - y)[Math.floor((a.length - 1) * q)]
			: null;
	const digest = async (file) =>
		createHash("sha256")
			.update(await readFile(join(repo, file)))
			.digest("hex");
	const untouchedAfter = await untouchedDigest();
	const result = {
		untouchedUnchanged: untouchedBefore === untouchedAfter,
		node: process.version,
		mode,
		count,
		fileCount,
		modified,
		scenario,
		statements,
		selects,
		requests,
		bytes,
		rows: Number(rows.count),
		wallMs,
		cpuMs: (cpu.user + cpu.system) / 1000,
		rss: memory.rss,
		heap: memory.heapUsed,
		rssDelta: memory.rss - memoryStart.rss,
		elu: performance.eventLoopUtilization(eluStart),
		eventLoopMs: {
			p95: loop.percentile(95) / 1e6,
			p99: loop.percentile(99) / 1e6,
			max: loop.max / 1e6,
		},
		pingMs: {
			count: pings.length,
			p50: percentile(pings, 0.5),
			p95: percentile(pings, 0.95),
			p99: percentile(pings, 0.99),
		},
		source: await digest("cross-seed/src/clients/QBittorrent.ts"),
		sourceHashes: Object.fromEntries(
			await Promise.all(
				[
					"cross-seed/src/clients/QBittorrent.ts",
					"cross-seed/src/searchee.ts",
					"cross-seed/src/action.ts",
					"cross-seed/src/clients/TorrentClient.ts",
					"cross-seed/dist/clients/QBittorrent.js",
					"cross-seed/dist/searchee.js",
					"cross-seed/dist/action.js",
					"cross-seed/dist/clients/TorrentClient.js",
					"cross-seed/src/routes/baseApi.ts",
					"cross-seed/dist/routes/baseApi.js",
				].map(async (file) => [file, await digest(file)]),
			),
		),
		compiled: await digest("cross-seed/dist/clients/QBittorrent.js"),
	};
	console.log(JSON.stringify(result));
	assert.equal(
		Number(rows.count),
		count,
		"target refresh must preserve other rows",
	);
	if (mode !== "baseline")
		assert.equal(
			untouchedBefore,
			untouchedAfter,
			"only requested source may change",
		);
	if (process.env.QB_ASSERT_TARGETED)
		assert.equal(selects, 0, "single refresh must not scan cached catalog");
} catch (e) {
	failure = e;
} finally {
	pinging = false;
	await pingLoop;
	loop.disable();
	await pingServer.close();
	await db.destroy();
	await new Promise((r) => server.close(r));
	await rm(config, { recursive: true, force: true });
}
if (failure) throw failure;
