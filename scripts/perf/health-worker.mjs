// Disposable loopback qB + actual compiled health router. Never accepts client URLs/configs.
import { createServer } from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir, cpus, arch, platform, release } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
	createRequire,
	registerHooks,
	syncBuiltinESMExports,
} from "node:module";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
const repo = resolve(process.argv[2]);
const tabs = Number(process.env.HEALTH_TABS || 10);
const paths = Number(process.env.HEALTH_PATHS || 2);
const torrents = Number(process.env.HEALTH_TORRENTS || 100);
const rows = Number(process.env.HEALTH_DB_ROWS || 150000);
const slow = Number(process.env.HEALTH_DELAY_MS || 0);
const fail = process.env.HEALTH_FAIL === "1";
const metrics = {
	providers: {},
	http: {},
	bytes: 0,
	requestBytes: 0,
	sql: 0,
	dbstat: 0,
	dbstatMs: [],
	fs: {},
	writes: 0,
};
globalThis.__healthPerf = metrics;
registerHooks({
	load(url, context, next) {
		const result = next(url, context);
		if (
			url ===
			pathToFileURL(join(repo, "cross-seed/dist/problems.js")).href
		) {
			result.source = String(result.source).replace(
				"registration.provider()",
				"(async () => { const started = performance.now(); try { return await registration.provider(); } finally { const m = globalThis.__healthPerf.providers[registration.id] ||= []; m.push(performance.now() - started); } })()",
			);
		}
		return result;
	},
});
for (const name of [
	"stat",
	"readdir",
	"writeFile",
	"unlink",
	"rm",
	"link",
	"copyFile",
	"access",
]) {
	const original = fsp[name];
	fsp[name] = async (...args) => {
		metrics.fs[name] = (metrics.fs[name] || 0) + 1;
		if (["writeFile", "unlink", "rm", "link", "copyFile"].includes(name))
			metrics.writes++;
		return original(...args);
	};
}
for (const name of [
	"statSync",
	"accessSync",
	"readdirSync",
	"writeFileSync",
	"unlinkSync",
	"rmSync",
]) {
	const original = fs[name];
	fs[name] = (...args) => {
		metrics.fs[name] = (metrics.fs[name] || 0) + 1;
		if (["writeFileSync", "unlinkSync", "rmSync"].includes(name))
			metrics.writes++;
		return original(...args);
	};
}
syncBuiltinESMExports();
const originalPrepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql) {
	metrics.sql++;
	if (/\bdbstat\b/i.test(sql)) metrics.dbstat++;
	const statement = originalPrepare.call(this, sql);
	if (/\bdbstat\b/i.test(sql)) {
		const all = statement.all;
		statement.all = function (...args) {
			const started = performance.now();
			try {
				return all.apply(statement, args);
			} finally {
				metrics.dbstatMs.push(performance.now() - started);
			}
		};
	}
	return statement;
};
const root = await fsp.mkdtemp(join(tmpdir(), "compiled-health-"));
process.env.CONFIG_DIR = root;
const sourceDirs = [];
for (let i = 0; i < paths; i++) {
	const dir = join(root, `source-${i}`);
	await fsp.mkdir(dir);
	await fsp.writeFile(join(dir, "media.mkv"), "fixture");
	sourceDirs.push(dir);
}
const linkDir = join(root, "links");
await fsp.mkdir(linkDir);
const catalog = Array.from({ length: torrents }, (_, i) => ({
	hash: i.toString(16).padStart(40, "0"),
	name: `Fixture.S01E${String(i % 99).padStart(2, "0")}.mkv`,
	save_path: sourceDirs[i % Math.max(paths, 1)] || root,
	category: "",
	tags: "",
	total_size: 7,
	files: [{ name: "media.mkv", size: 7, progress: 1 }],
	trackers: [],
}));
const payload = JSON.stringify(catalog);
const leanPayload = JSON.stringify(
	catalog.map(({ files, trackers, ...torrent }) => torrent),
);
const server = createServer(async (req, res) => {
	const path = req.url;
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const requestBody = Buffer.concat(chunks);
	metrics.requestBytes += requestBody.byteLength;
	const params = new URLSearchParams(requestBody.toString());
	metrics.http[path] = (metrics.http[path] || 0) + 1;
	if (slow && path !== "/api/ping")
		await new Promise((r) => setTimeout(r, slow));
	let body;
	if (path === "/api/ping") body = "pong";
	else if (path === "/api/v2/auth/login") {
		if (fail) {
			res.statusCode = 401;
			body = "denied";
		} else {
			res.setHeader("Set-Cookie", "SID=fixture");
			body = "Ok.";
		}
	} else if (path === "/api/v2/app/version") body = "v5.1.0";
	else if (path === "/api/v2/torrents/createTags") body = "";
	else if (path === "/api/v2/torrents/info") {
		if (fail) {
			res.statusCode = 500;
			body = "[]";
		} else
			body =
				params.get("includeFiles") === "true" ? payload : leanPayload;
	} else if (path === "/api/v2/app/preferences") body = "{}";
	else {
		res.statusCode = 404;
		body = "unknown fixture endpoint";
	}
	metrics.bytes += Buffer.byteLength(body);
	res.end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const address = `http://127.0.0.1:${server.address().port}`;
const load = (path) =>
	import(pathToFileURL(join(repo, `cross-seed/dist/${path}`)));
const { db } = await load("db.js");
const { createAppDirHierarchy, getDefaultRuntimeConfig } =
	await load("configuration.js");
const { initializeLogger } = await load("logger.js");
const { setRuntimeConfig } = await load("runtimeConfig.js");
const { setClientsForTesting } = await load("clients/TorrentClient.js");
const { default: QBittorrent } = await load("clients/QBittorrent.js");
createAppDirHierarchy();
initializeLogger({ verbose: false });
await db.migrate.latest();
await fsp.mkdir(join(root, "cross-seeds"), { recursive: true });
setRuntimeConfig({
	...getDefaultRuntimeConfig(),
	torrentClients: [`qbittorrent:${address}`],
	linkDirs: paths ? [linkDir] : [],
	torrentDir: undefined,
	dataDirs: [],
	outputDir: join(root, "cross-seeds"),
});
const client = new QBittorrent(address, "fixture", 0, false);
setClientsForTesting([client]);
if (!fail) {
	await client.validateConfig();
	if (paths)
		await client.getClientSearchees({
			includeFiles: true,
			includeTrackers: true,
		});
}
const sqlite = new DatabaseSync(join(root, "cross-seed.db"));
sqlite.exec("CREATE TABLE fixture_blob (id INTEGER PRIMARY KEY, payload TEXT)");
const insert = sqlite.prepare("INSERT INTO fixture_blob(payload) VALUES (?)");
sqlite.exec("BEGIN");
for (let i = 0; i < rows; i++) insert.run("x".repeat(256));
sqlite.exec("COMMIT");
sqlite.close();
const require = createRequire(pathToFileURL(join(repo, "package.json")));
const Fastify = require("fastify");
const pingServer = Fastify({ logger: false });
const { baseApiPlugin } = await load("routes/baseApi.js");
await pingServer.register(baseApiPlugin, { prefix: "/api" });
const pingAddress = await pingServer.listen({ host: "127.0.0.1", port: 0 });
const { healthRouter } = await load("trpc/routers/health.js");
const caller = healthRouter.createCaller({
	user: { id: 1, username: "fixture" },
});
Object.assign(metrics, {
	providers: {},
	http: {},
	bytes: 0,
	requestBytes: 0,
	sql: 0,
	dbstat: 0,
	dbstatMs: [],
	fs: {},
	writes: 0,
});
const delay = monitorEventLoopDelay({ resolution: 1 });
delay.enable();
const pings = [];
let pingActive = true;
const pingLoop = (async () => {
	while (pingActive) {
		const t = performance.now();
		const response = await fetch(`${pingAddress}/api/ping`);
		if ((await response.text()) !== "OK") throw new Error("ping failed");
		pings.push(performance.now() - t);
		await new Promise((r) => setTimeout(r, 2));
	}
})();
await new Promise((r) => setTimeout(r, 10));
let peakRss = process.memoryUsage().rss;
const memorySampler = setInterval(() => {
	peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 2);
const cpu = process.cpuUsage();
const elu = performance.eventLoopUtilization();
const start = performance.now();
const batches = [];
for (let batch = 0; batch < 3; batch++) {
	const t = performance.now();
	const values = await Promise.all(
		Array.from({ length: tabs }, () => caller.get()),
	);
	batches.push({
		wallMs: performance.now() - t,
		problemIds: values[0].problems.map((p) => [p.id, p.severity]),
		dbPages: values[0].diagnostics.db.pageCount,
		measuredAt: values[0].measuredAt || null,
	});
}
const wallMs = performance.now() - start;
const cpuUsage = process.cpuUsage(cpu);
const loop = performance.eventLoopUtilization(elu);
clearInterval(memorySampler);
peakRss = Math.max(peakRss, process.memoryUsage().rss);
pingActive = false;
await pingLoop;
delay.disable();
const percentile = (values, q) =>
	values.sort((a, b) => a - b)[
		Math.min(values.length - 1, Math.floor(values.length * q))
	] || 0;
const compiledFiles = [
	"health.js",
	"healthGeneration.js",
	"trpc/routers/health.js",
	"problems.js",
	"clients/QBittorrent.js",
	"clients/Deluge.js",
	"clients/TorrentClient.js",
	"runtimeConfig.js",
	"searchee.js",
	"diagnostics/db.js",
	"routes/baseApi.js",
];
const compiledHashes = {};
for (const file of compiledFiles) {
	try {
		compiledHashes[file] = createHash("sha256")
			.update(await fsp.readFile(join(repo, "cross-seed/dist", file)))
			.digest("hex");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		compiledHashes[file] = null;
	}
}
const result = {
	repo,
	node: process.version,
	machine: {
		cpu: cpus()[0]?.model,
		arch: arch(),
		platform: platform(),
		release: release(),
	},
	compiledHashes,
	instrumentationHash: createHash("sha256")
		.update(await fsp.readFile(fileURLToPath(import.meta.url)))
		.digest("hex"),
	sqlite: process.versions.sqlite,
	sha: createHash("sha256")
		.update(
			await fsp.readFile(
				join(repo, "cross-seed/dist/trpc/routers/health.js"),
			),
		)
		.digest("hex"),
	scenario: { tabs, paths, torrents, rows, slow, fail },
	wallMs,
	cpuUsage,
	rss: process.memoryUsage().rss,
	peakRss,
	heap: process.memoryUsage().heapUsed,
	loopUtilization: loop.utilization,
	loopMs: {
		p95: delay.percentile(95) / 1e6,
		p99: delay.percentile(99) / 1e6,
		max: delay.max / 1e6,
	},
	pingMs: {
		samples: pings.length,
		p50: percentile(pings, 0.5),
		p95: percentile(pings, 0.95),
		p99: percentile(pings, 0.99),
	},
	metrics: structuredClone(metrics),
	batches,
};
await pingServer.close();
await db.destroy();
await new Promise((r) => server.close(r));
await fsp.rm(root, { recursive: true, force: true });
console.log(`HEALTH_RESULT=${JSON.stringify(result)}`);
if (process.env.HEALTH_ASSERT_COALESCING === "1") {
	const assert = (await import("node:assert/strict")).default;
	assert.equal(
		result.metrics.dbstat,
		1,
		"concurrent router queries must share one dbstat aggregate",
	);
	assert.equal(
		result.metrics.http["/api/v2/torrents/createTags"] || 0,
		0,
		"recurring health must not create tags",
	);
	if (!fail)
		assert.ok(
			result.batches.every(
				(batch) =>
					!batch.problemIds.some(
						([id]) =>
							id.startsWith("client:validation:") ||
							id.startsWith("client:linking-") ||
							id.startsWith("problem-provider-error:"),
					),
			),
			"healthy fixtures must retain successful client/provider outcomes",
		);
	assert.ok(
		result.batches.every((batch) => batch.measuredAt),
		"snapshot measurement timestamp must be visible",
	);
}
