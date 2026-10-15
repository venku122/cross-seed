// Actual compiled cleanup/access/qB adapter on a disposable copied DB.
// No filesystem mocks, no writable connection to snapshot, no live qB transport.
import { stageColdInput } from "./cold-copy.mjs";
import { access, stat } from "node:fs/promises";
import { DatabaseSync, backup } from "node:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { cacheSemanticDigest, visibleMembershipDigests } from "./digests.mjs";
import { fixtureTransportDestination } from "./transport-gate.mjs";
import { createActiveProfiler } from "../profiling.mjs";
const id = process.env.RUN_ID ?? "review-run";
if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid run id");
const output = join("/results", id, "private");
mkdirSync(output, { recursive: true, mode: 0o700 });
const config = JSON.parse(
	readFileSync(
		process.env.PRIVATE_CONFIG ?? "/snapshot/benchmark-config.json",
		"utf8",
	),
);
if (
	!Array.isArray(config.dataDirs) ||
	!Array.isArray(config.clients) ||
	!config.clients.length ||
	!Array.isArray(config.mediaSentinels) ||
	!config.mediaSentinels.length
)
	throw new Error(
		"Explicit private source/root/sentinel configuration required",
	);
for (const root of config.dataDirs) await access(root);
for (const path of config.mediaSentinels) {
	const observed = await stat(path);
	if (!observed.isFile() || observed.size <= 0)
		throw new Error("Read-only media sentinel unavailable");
}
const configDir = join(output, "config");
mkdirSync(configDir, { mode: 0o700 });
process.env.CONFIG_DIR = configDir;
const coldInput = await stageColdInput(
	process.env.SNAPSHOT_DB ?? "/snapshot/cross-seed.db",
	join(output, "cold-input.db"),
);
const cold = new DatabaseSync(coldInput, { readOnly: true });
await backup(cold, join(configDir, "cross-seed.db"));
cold.close();
const root = resolve(
	process.env.COMPILED_CHECKOUT ?? "/opt/root-performance/dependencies",
);
const load = (name) =>
	import(pathToFileURL(join(root, "cross-seed/dist", name + ".js")));
const { db, cleanupDB } = await load("db");
const { createAppDirHierarchy, getDefaultRuntimeConfig } =
	await load("configuration");
createAppDirHierarchy();
const logging = await load("logger");
logging.initializeLogger({ verbose: false });
logging.logger.silent = true;
const { setRuntimeConfig } = await load("runtimeConfig");
setRuntimeConfig({
	...getDefaultRuntimeConfig(),
	dataDirs: config.dataDirs,
	seasonFromEpisodes: config.seasonFromEpisodes ?? 1,
	useClientTorrents: true,
});
await db.migrate.latest();
const { default: QBittorrent } = await load("clients/QBittorrent");
const { setClientsForTesting } = await load("clients/TorrentClient");
const originalFetch = globalThis.fetch;
async function waitReady(url) {
	for (let attempt = 0; attempt < 120; attempt++) {
		try {
			const response = await originalFetch(url);
			if (response.ok) return;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error("Private benchmark dependency not ready");
}
await waitReady("http://fixture:4041/bench/stats");
await waitReady("http://controller:4042/bench/ready");
const originalSources = config.clients.map((client) => {
	const url = new URL(client.sourceLocator);
	if (url.username || url.password)
		throw new Error("Source locators must omit credentials");
	return url;
});
globalThis.fetch = async (url, options = {}) => {
	const parsed = new URL(String(url));
	// Only external fixture/controller transports are permitted; original client
	// identities are retained by constructing adapters from their real locators.
	if (parsed.hostname === "controller" && parsed.port === "4042")
		return originalFetch(url, options);
	return originalFetch(
		fixtureTransportDestination(url, config.clients),
		options,
	);
};
const operations = Number(process.env.BENCH_OPERATIONS ?? 1);
if (!Number.isSafeInteger(operations) || operations < 1 || operations > 1000)
	throw new Error("Invalid operation repetitions");
const clientFailures = [];
const clients = config.clients.map(
	(client, index) =>
		new QBittorrent(
			originalSources[index].href,
			client.clientHost,
			index,
			true,
		),
);
for (const client of clients) {
	await client.login();
	const original = client.getClientSearchees.bind(client);
	client.getClientSearchees = async (...args) => {
		try {
			return await original(...args);
		} catch (error) {
			clientFailures.push({
				clientHost: client.clientHost,
				error: error.stack ?? String(error),
			});
			throw error;
		}
	};
}
setClientsForTesting(clients);
const beforeRows = Number(
	(await db("client_searchee").count({ n: "*" }).first()).n,
);
const { serve } = await load("server");
let ready;
const listening = new Promise((resolve) => (ready = resolve));
const serving = serve(4040, "0.0.0.0", "", ready);
await listening;
const startResponse = await originalFetch(
	"http://controller:4042/worker-ready",
	{ method: "POST" },
);
if (!startResponse.ok) throw new Error("External controller not ready");
const profiler = createActiveProfiler(process.env.BENCH_PROFILE === "1");
const loop = monitorEventLoopDelay({ resolution: 5 });
loop.enable();
profiler.begin();
const memoryBefore = process.memoryUsage(),
	memoryPeak = { ...memoryBefore };
let samples = 0;
const sample = () => {
	samples++;
	for (const [key, value] of Object.entries(process.memoryUsage()))
		memoryPeak[key] = Math.max(memoryPeak[key], value);
};
const timer = setInterval(sample, 10);
const cpuStart = process.cpuUsage(),
	start = performance.now();
let failure;
try {
	for (let operation = 0; operation < operations; operation++)
		await cleanupDB();
} catch (error) {
	failure = error;
}
const wallMs = performance.now() - start,
	cpuUs = process.cpuUsage(cpuStart);
sample();
clearInterval(timer);
const profiling = await profiler.end();
// End load admission before untimed integrity/storage validation.
const stopped = await originalFetch("http://controller:4042/window-end", {
	method: "POST",
});
if (!stopped.ok) throw new Error("External admission stop failed");
loop.disable();
const afterRows = Number(
	(await db("client_searchee").count({ n: "*" }).first()).n,
);
const integrity = await db.raw("PRAGMA integrity_check"),
	foreignKeys = await db.raw("PRAGMA foreign_key_check");
const cache = await cacheSemanticDigest(db);
let ownedQuery;
try {
	ownedQuery = (await load("sourceStore")).sourceMembershipQuery;
} catch (error) {
	if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
}
const memberships = await visibleMembershipDigests(db, ownedQuery);
const result = {
	operations,
	failedClientRefreshes: clientFailures.length,
	rpcReplayDelayMs: Number(process.env.RPC_DELAY_MS ?? 0),
	sqliteWorkerEnabled: process.env.CROSS_SEED_SQLITE_WORKER === "1",
	success:
		!failure &&
		clientFailures.length === 0 &&
		afterRows === beforeRows &&
		integrity.every((row) => row.integrity_check === "ok") &&
		foreignKeys.length === 0,
	profiled: process.env.BENCH_PROFILE === "1",
	wallMs: {
		n: 1,
		p50: wallMs,
		p95: wallMs,
		p99: wallMs,
		max: wallMs,
		raw: [wallMs],
	},
	cpuUs,
	memoryBefore,
	memoryPeak,
	profiling,
	loopMs: {
		p95: loop.percentile(95) / 1e6,
		p99: loop.percentile(99) / 1e6,
		max: loop.max / 1e6,
	},
	cacheRows: afterRows,
	rawDataRows: Number((await db("data").count({ n: "*" }).first()).n),
	rawLegacyMembershipRows: Number(
		(await db("ensemble").count({ n: "*" }).first()).n,
	),
	memorySamples: samples,
	private: {
		cache,
		memberships,
		clientFailures,
		clients: config.clients,
		roots: config.dataDirs,
		integrity,
		foreignKeys,
		failure: failure?.stack,
	},
};
writeFileSync(join(output, "daemon-result.json"), JSON.stringify(result), {
	mode: 0o600,
});
const response = await originalFetch("http://controller:4042/worker-finished", {
	method: "POST",
	body: JSON.stringify(result),
});
if (!response.ok) throw new Error("Result capture failed");
process.emit("SIGTERM");
await serving;
await db.destroy();
globalThis.fetch = originalFetch;
if (!result.success) process.exitCode = 1;
