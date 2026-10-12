// Actual compiled adapter methods, synthetic transport responses, real Node SQLite.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { createRequire } from "node:module";
const [
	repoArg = ".",
	clientName = "QBittorrent",
	countArg = "1001",
	scenario = "unchanged",
	filesArg = "4",
	check = "",
	warmth = "cold-ish",
] = process.argv.slice(2);
const count = Number(countArg),
	fileCount = Number(filesArg);
const root = await mkdtemp(join(tmpdir(), "cross-seed-cache-batch-"));
process.env.CONFIG_DIR = root;
await mkdir(join(root, "logs"), { recursive: true });
const load = (name) =>
	import(pathToFileURL(resolve(repoArg, "cross-seed/dist", name)).href);
const { db } = await load("db.js");
const { createAppDirHierarchy, getDefaultRuntimeConfig } =
	await load("configuration.js");
const { setRuntimeConfig } = await load("runtimeConfig.js");
const { initializeLogger } = await load("logger.js");
createAppDirHierarchy();
initializeLogger({ verbose: false });
setRuntimeConfig(getDefaultRuntimeConfig());
await db.migrate.latest();
const sqliteVersion = (await db.raw("select sqlite_version() as version"))[0]
	.version;
const Client = (await load(`clients/${clientName}.js`)).default;
const { resultOf, resultOfErr } = await load("Result.js");
const client = new Client("http://127.0.0.1:9", "fixture-host", 0, true);
const hash = (i) => i.toString(16).padStart(40, "0");
const files = Array.from({ length: fileCount }, (_, i) => ({
	name: `f${i}.mkv`,
	path: `Fixture/f${i}.mkv`,
	length: 100,
}));
const records = Array.from({ length: count }, (_, i) => ({
	info_hash: hash(i + 1),
	name: `Fixture.${i}.2020`,
	title: `Fixture.${i}.2020`,
	files: JSON.stringify(files),
	length: 100 * fileCount,
	client_host: client.clientHost,
	save_path: "/synthetic",
	category:
		clientName === "QBittorrent" || clientName === "Deluge"
			? "fixture"
			: null,
	tags:
		clientName === "QBittorrent" ||
		clientName === "Transmission" ||
		clientName === "RTorrent"
			? JSON.stringify(["fixture"])
			: null,
	trackers: JSON.stringify(["tracker.invalid"]),
}));
for (let i = 0; i < records.length; i += 100)
	await db("client_searchee").insert(records.slice(i, i + 100));
if (count)
	await db("client_searchee").insert({
		...records[0],
		client_host: "other-host",
		name: "Other",
	});
const changed = scenario === "changed10" ? 10 : scenario === "changed1" ? 1 : 0;
const live = records.map((r, i) => ({
	...r,
	name: i < changed ? `${r.name}.changed` : r.name,
	files:
		scenario === "force-all"
			? files.map((f, index) =>
					index === 0
						? {
								...f,
								name: "renamed.mkv",
								path: "Fixture/renamed.mkv",
							}
						: f,
				)
			: files,
	trackers:
		scenario === "force-all"
			? ["https://updated.invalid/announce"]
			: ["https://tracker.invalid/announce"],
}));
if (scenario === "removed" && count) live.pop();
if (scenario === "new")
	live.push({
		...records[0],
		info_hash: hash(count + 1),
		name: "New.2020",
		files,
		trackers: ["https://tracker.invalid/announce"],
		save_path: "/synthetic",
		category: "fixture",
		tags: '["fixture"]',
	});
if (scenario === "empty-files" && live.length) live[0].files = [];
if (scenario === "moved" && live.length) live[0].save_path = "/synthetic-moved";
const liveByHash = new Map(live.map((r) => [r.info_hash, r]));
if (scenario === "refresh-one")
	live.forEach((r, i) => liveByHash.set(hash(count + i + 1), r));
let requests = 0,
	bytes = 0;
const response = (value) => {
	requests++;
	bytes += Buffer.byteLength(JSON.stringify(value));
	if (scenario === "error") throw new Error("synthetic transport failure");
	return value;
};
const qb = (options) =>
	live.map((r, index) => ({
		hash: (scenario === "refresh-one"
			? hash(count + index + 1)
			: r.info_hash
		).toUpperCase(),
		infohash_v1: r.info_hash,
		name: r.name,
		save_path: r.save_path,
		category: r.category ?? "",
		tags: "fixture",
		total_size: r.length,
		files: options?.includeFiles
			? r.files.map((f) => ({ name: f.path, size: f.length }))
			: undefined,
		trackers: options?.includeTrackers
			? r.trackers.map((url) => ({ url, tier: 0 }))
			: undefined,
	}));
client.getAllTorrentInfo = async (options) => response(qb(options));
client.getFiles = async (hash) => {
	const r = liveByHash.get(hash.toLowerCase());
	response(r.files.map((f) => ({ name: f.path, size: f.length })));
	return r.files;
};
client.getTrackers = async (hash) => {
	const r = liveByHash.get(hash.toLowerCase());
	response(r.trackers.map((url) => ({ url, tier: 0 })));
	return r.trackers.map((url) => new URL(url).host);
};
client.request = async () =>
	response({
		torrents: live.map((r) => ({
			hashString: r.info_hash.toUpperCase(),
			name: r.name,
			downloadDir: r.save_path,
			labels: ["fixture"],
			totalSize: r.length,
			files: r.files.map((f) => ({ name: f.path, length: f.length })),
			trackers: r.trackers.map((announce) => ({ announce, tier: 0 })),
		})),
	});
client.call = async () => {
	requests++;
	if (scenario === "error")
		return resultOfErr(new Error("synthetic failure"));
	const value = {
		torrents: Object.fromEntries(
			live.map((r) => [
				r.info_hash.toUpperCase(),
				{
					name: r.name,
					save_path: r.save_path,
					label: r.category ?? "",
					total_size: r.length,
					files: r.files.map((f) => ({
						path: f.path,
						size: f.length,
					})),
					trackers: r.trackers.map((url) => ({ url, tier: 0 })),
				},
			]),
		),
	};
	bytes += Buffer.byteLength(JSON.stringify(value));
	return resultOf(value);
};
client.methodCallP = async (method, args) => {
	if (method === "download_list")
		return response(live.map((r) => r.info_hash.toUpperCase()));
	return response(
		args[0].map((a) => {
			const r = liveByHash.get(a.params[0].toLowerCase());
			return [
				a.methodName === "d.name"
					? r.name
					: a.methodName === "d.size_bytes"
						? String(r.length)
						: a.methodName === "d.directory"
							? `${r.save_path}/Fixture`
							: a.methodName === "d.is_multi_file"
								? "1"
								: a.methodName === "d.custom1"
									? "fixture"
									: a.methodName === "f.multicall"
										? r.files.map((f) => [
												f.path.replace("Fixture/", ""),
												String(f.length),
											])
										: r.trackers.map((url) => [url, "0"]),
			];
		}),
	);
};
if (warmth === "warm" && scenario === "unchanged")
	await client.getClientSearchees();
requests = 0;
bytes = 0;
const selects = [];
let cacheReadBytes = 0;
db.on("query-response", (response, query) => {
	if (
		query.sql.startsWith("select") &&
		query.sql.includes("client_searchee")
	) {
		const rows = Array.isArray(response)
			? response
			: response && typeof response === "object"
				? [response]
				: [];
		for (const row of rows)
			for (const value of Object.values(row))
				if (typeof value === "string")
					cacheReadBytes += Buffer.byteLength(value);
	}
});
db.on("query", (q) => {
	if (q.sql.startsWith("select") && q.sql.includes("client_searchee"))
		selects.push(q.sql);
});
const loop = monitorEventLoopDelay({ resolution: 1 });
loop.enable();
const require = createRequire(
	pathToFileURL(resolve(repoArg, "cross-seed/package.json")),
);
const fastify = require("fastify");
const { baseApiPlugin } = await load("routes/baseApi.js");
const pingServer = fastify({ logger: false });
await pingServer.register(baseApiPlugin, { prefix: "/api" });
const pingOrigin = await pingServer.listen({ port: 0, host: "127.0.0.1" });
const pingUrl = `${pingOrigin}/api/ping`;
const warmPing = await fetch(pingUrl);
assert.equal(await warmPing.text(), "OK");
const pings = [];
let running = true;
const pingLoop = (async () => {
	while (running) {
		const start = performance.now();
		const pingResponse = await fetch(pingUrl);
		assert.equal(pingResponse.status, 200);
		assert.equal(await pingResponse.text(), "OK");
		pings.push(performance.now() - start);
		await new Promise((r) => setTimeout(r, 1));
	}
})();
await new Promise((r) => setTimeout(r, 10));
pings.splice(0);
const busyPingStart = performance.now();
const busyPing = fetch(pingUrl).then(async (response) => {
	assert.equal(response.status, 200);
	assert.equal(await response.text(), "OK");
	pings.push(performance.now() - busyPingStart);
});
loop.reset();
const eluStart = performance.eventLoopUtilization();
const cpu = process.cpuUsage(),
	rss = process.memoryUsage().rss,
	start = performance.now();
const originalParse = JSON.parse;
let filesJsonParses = 0;
JSON.parse = (text, ...args) => {
	if (typeof text === "string" && text.startsWith('[{"name":'))
		filesJsonParses++;
	return originalParse(text, ...args);
};
let output, error;
try {
	output = await client.getClientSearchees(
		scenario === "force-all" || scenario === "empty-files"
			? { refresh: [], includeFiles: true, includeTrackers: true }
			: scenario === "new-only"
				? { newSearcheesOnly: true }
				: scenario === "refresh-one"
					? { refresh: [records[0].info_hash] }
					: undefined,
	);
} catch (e) {
	error = e.message;
}
JSON.parse = originalParse;
const elu = performance.eventLoopUtilization(eluStart);
const wallMs = performance.now() - start,
	cpuUsed = process.cpuUsage(cpu),
	memory = process.memoryUsage();
const peakRssAfterCall = process.resourceUsage().maxRSS * 1024;
running = false;
await Promise.all([pingLoop, busyPing]);
loop.disable();
await pingServer.close();
const measuredSelects = selects.slice();
const measuredCacheReadBytes = cacheReadBytes;
if (scenario === "unchanged")
	assert.ok(
		cacheReadBytes >= count * Buffer.byteLength(JSON.stringify(files)),
		"cached file string bytes were not counted",
	);
const rows = await db("client_searchee").orderBy(["client_host", "info_hash"]);
assert.equal(
	rows.filter((r) => r.client_host === "other-host").length,
	count ? 1 : 0,
);
if (scenario === "error")
	assert.equal(
		rows.filter((r) => r.client_host === client.clientHost).length,
		count,
	);
else if (count || scenario === "new") {
	assert.equal(
		output.searchees.length,
		scenario === "new-only"
			? 0
			: scenario === "empty-files"
				? live.length - 1
				: live.length,
	);
	assert.deepEqual(
		output.searchees.map((s) => s.infoHash),
		scenario === "new-only"
			? []
			: (scenario === "empty-files" ? live.slice(1) : live).map(
					(r) => r.info_hash,
				),
	);
	assert.equal(
		output.newSearchees.length,
		scenario === "force-all"
			? count
			: scenario === "empty-files"
				? count - 1
				: scenario === "new" ||
					  scenario === "refresh-one" ||
					  scenario === "moved"
					? 1
					: Math.min(changed, count),
	);
	assert.equal(
		rows.filter((r) => r.client_host === client.clientHost).length,
		live.length,
	);
	if (scenario === "force-all") {
		assert.deepEqual(output.searchees[0]?.trackers, ["updated.invalid"]);
		assert.equal(
			output.searchees[0]?.files[0]?.path,
			"Fixture/renamed.mkv",
		);
	}
}
selects.splice(0, selects.length, ...measuredSelects);
if (check === "assert-batched" && count && scenario !== "error")
	assert.ok(
		selects.length <=
			Math.ceil(live.length / 500) *
				(scenario === "new-only" ||
				scenario === "force-all" ||
				scenario === "empty-files"
					? 1
					: 3) +
				(scenario === "new-only" || scenario === "force-all"
					? 0
					: 2 *
						Math.ceil(
							(live.length *
								Buffer.byteLength(JSON.stringify(files))) /
								(1024 * 1024),
						)) +
				1,
		`${selects.length} cache SELECTs exceed bounded batch limit`,
	);
const percentile = (values, p) =>
	values.toSorted((a, b) => a - b)[
		Math.max(0, Math.ceil(values.length * p) - 1)
	] ?? null;
console.log(
	JSON.stringify({
		clientName,
		nodeVersion: process.version,
		sqliteVersion,
		count,
		fileCount,
		scenario,
		warmth,
		cacheReadBytes: measuredCacheReadBytes,
		filesJsonParses,
		outputFiles: output?.searchees.reduce((n, s) => n + s.files.length, 0),
		error,
		wallMs,
		cpuMs: (cpuUsed.user + cpuUsed.system) / 1000,
		eventLoopUtilization: elu.utilization,
		eventLoopActiveMs: elu.active,
		eventLoopIdleMs: elu.idle,
		rssBefore: rss,
		rssAfter: memory.rss,
		processPeakRssBytes: peakRssAfterCall,
		heapUsed: memory.heapUsed,
		selects: selects.length,
		fullRowSelects: selects.filter((s) => s.includes("select *")).length,
		requests,
		bytes,
		outputCount: output?.searchees.length,
		newCount: output?.newSearchees.length,
		outputDigest: createHash("sha256")
			.update(JSON.stringify(output ?? null))
			.digest("hex"),
		rowsDigest: createHash("sha256")
			.update(JSON.stringify(rows))
			.digest("hex"),
		loopSamples: loop.count,
		loopP95Ms: loop.count ? loop.percentile(95) / 1e6 : null,
		loopP99Ms: loop.count ? loop.percentile(99) / 1e6 : null,
		loopMaxMs: loop.count ? loop.max / 1e6 : null,
		pingSamples: pings.length,
		pingP50Ms: percentile(pings, 0.5),
		pingP95Ms: percentile(pings, 0.95),
		pingP99Ms: percentile(pings, 0.99),
	}),
);
await db.destroy();
await rm(root, { recursive: true, force: true });
