// End-to-end compiled cleanup: actual qB adapter, migrated SQLite, generator,
// staging/pruning/housekeeping and production HTTP ping. Synthetic transport and
// filesystem access; no live client, media, NFS or workload-weight evidence.
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, cpus, platform, arch } from "node:os";
import { resolve, join, dirname, basename, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { syncBuiltinESMExports, registerHooks } from "node:module";
import bencode from "bencode";
import { fork, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { createHash } from "node:crypto";

const quantiles = (values) => {
	const sorted = values.slice().sort((a, b) => a - b);
	const at = (p) =>
		sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ??
		null;
	return {
		n: sorted.length,
		p50: at(0.5),
		p95: at(0.95),
		p99: at(0.99),
		max: sorted.at(-1) ?? null,
		raw: values,
	};
};

if (process.argv[2] === "ping") {
	let stop = false;
	let measuring = false;
	let errors = 0;
	let bytes = 0;
	const times = [];
	process.on("disconnect", () => {
		stop = true;
	});
	process.on("message", (message) => {
		if (message === "begin") {
			times.length = 0;
			measuring = true;
			process.send("begun");
		}
		if (message === "stop") stop = true;
	});
	while (!stop) {
		const begin = performance.now();
		try {
			const response = await fetch(process.argv[3]);
			const body = await response.text();
			if (response.status !== 200 || body !== "OK")
				throw new Error("ping failed");
			if (measuring) {
				times.push(performance.now() - begin);
				bytes += body.length;
			}
		} catch {
			if (measuring) errors++;
		}
		await new Promise((done) => setTimeout(done, 5));
	}
	if (process.connected) {
		process.send({ ping: quantiles(times), errors, bytes });
		process.disconnect();
	}
} else {
	const [
		checkout,
		pathCount = "100",
		members = "5",
		delay = "0",
		operations = "1",
		mode = "cleanup",
		rootDelay = "0",
		missingEveryArg = "0",
		accessMode = "mock",
		fixtureRootArg = "/synthetic/root",
		pathListArg,
	] = process.argv.slice(2);
	const root = resolve(checkout);
	const fixtureRoot = resolve(fixtureRootArg);
	const count = Number(pathCount);
	const memberships = Number(members);
	const delayMs = Number(delay);
	const repeats = Number(operations);
	const rootDelayMs = Number(rootDelay);
	const missingEvery = Number(missingEveryArg);
	if (!["mock", "real"].includes(accessMode))
		throw new Error("Unknown access mode");
	if (
		accessMode === "real" &&
		(delayMs || missingEvery || rootDelayMs || !pathListArg)
	)
		throw new Error(
			"Real access requires a private JSON path list and zero mock delays/missing fraction",
		);
	const fixturePaths = pathListArg
		? JSON.parse(fs.readFileSync(pathListArg, "utf8"))
		: null;
	if (
		fixturePaths &&
		(!Array.isArray(fixturePaths) ||
			fixturePaths.length !== count ||
			new Set(fixturePaths).size !== count ||
			fixturePaths.some(
				(path) =>
					typeof path !== "string" ||
					!path.startsWith(`${fixtureRoot}${sep}`),
			))
	)
		throw new Error("Invalid private path fixture");
	const fixturePathSet = fixturePaths ? new Set(fixturePaths) : null;
	if (!["cleanup", "refresh", "index"].includes(mode))
		throw new Error("Unknown worker mode");
	const fileCount = Number(process.env.BENCH_FILES ?? 50);
	const clientCount = Number(process.env.BENCH_CLIENTS ?? 1);
	const sourceDelayMs = Number(process.env.BENCH_SOURCE_DELAY ?? 0);
	let refreshCalls = 0;
	let refreshedSearchees = 0;
	const adapter = {
		routes: {},
		requestBytes: 0,
		responseBytes: 0,
		fileJsonReadBytes: 0,
		insertBindingBytes: 0,
	};
	globalThis.__combinedPerf = { generatedRows: 0, generatedSources: 0 };
	registerHooks({
		load(url, context, next) {
			const loaded = next(url, context);
			if (
				url ===
				pathToFileURL(join(root, "cross-seed/dist/torrent.js")).href
			) {
				const before = String(loaded.source);
				const after = before.replace(
					"return ensemblePieces.map",
					"globalThis.__combinedPerf.generatedRows += ensemblePieces.length; globalThis.__combinedPerf.generatedSources++; return ensemblePieces.map",
				);
				if (before === after)
					throw new Error(
						"Actual generator instrumentation anchor missing",
					);
				globalThis.__combinedPerf.originalGeneratorSha256 = createHash(
					"sha256",
				)
					.update(before)
					.digest("hex");
				globalThis.__combinedPerf.executedGeneratorSha256 = createHash(
					"sha256",
				)
					.update(after)
					.digest("hex");
				loaded.source = after;
			}
			return loaded;
		},
	});
	const configDir = await mkdtemp(
		join(tmpdir(), "cross-seed-cleanup-bench-"),
	);
	process.env.CONFIG_DIR = configDir;
	const importSource = (name) =>
		import(pathToFileURL(join(root, "cross-seed/dist", `${name}.js`)).href);
	let calls = 0;
	let rootGuardAccessCalls = 0;
	let active = 0;
	let peakActive = 0;
	const originalAccess = fs.promises.access;
	fs.promises.access = async (path, ...args) => {
		if (path === fixtureRoot) {
			rootGuardAccessCalls++;
			if (accessMode === "real") return originalAccess(path, ...args);
			if (rootDelayMs)
				await new Promise((done) => setTimeout(done, rootDelayMs));
			return;
		}
		if (
			!(fixturePathSet
				? fixturePathSet.has(String(path))
				: String(path).startsWith(`${fixtureRoot}${sep}`))
		)
			return originalAccess(path, ...args);
		calls++;
		if (path === join(fixtureRoot, "missing-obsolete"))
			throw Object.assign(new Error("synthetic missing path"), {
				code: "ENOENT",
			});
		peakActive = Math.max(peakActive, ++active);
		if (accessMode === "real") {
			try {
				return await originalAccess(path, ...args);
			} finally {
				active--;
			}
		}
		if (delayMs) await new Promise((done) => setTimeout(done, delayMs));
		active--;
		if (
			missingEvery &&
			Number(String(path).split("/").at(-1)) % missingEvery === 0
		)
			throw Object.assign(new Error("synthetic missing path"), {
				code: "ENOENT",
			});
	};
	syncBuiltinESMExports();
	const { db, cleanupDB } = await importSource("db");
	// Disposable in-memory DB uses the production NodeSqliteClient and migrations.
	db.client.connectionSettings.filename = ":memory:";
	const { createAppDirHierarchy, getDefaultRuntimeConfig } =
		await importSource("configuration");
	const { setRuntimeConfig } = await importSource("runtimeConfig");
	const { initializeLogger } = await importSource("logger");
	createAppDirHierarchy();
	initializeLogger({ verbose: false });
	setRuntimeConfig({
		...getDefaultRuntimeConfig(),
		dataDirs: mode === "index" ? [] : [fixtureRoot],
		seasonFromEpisodes: 1,
		useClientTorrents: mode !== "cleanup",
	});
	await db.migrate.latest();
	if (fixturePaths) {
		for (let offset = 0; offset < count; offset += 100) {
			await db("data").insert(
				fixturePaths
					.slice(offset, offset + 100)
					.map((path) => ({ path, title: "Synthetic fixture" })),
			);
		}
	} else {
		await db.raw(
			`WITH RECURSIVE numbers(n) AS (SELECT 0 WHERE ? > 0 UNION ALL SELECT n+1 FROM numbers WHERE n+1 < ?) INSERT INTO data(path,title) SELECT ? || ? || printf('%09d', n), 'Synthetic fixture' FROM numbers`,
			[count, count, fixtureRoot, sep],
		);
	}
	for (let member = 0; mode === "cleanup" && member < memberships; member++) {
		await db.raw(
			"INSERT INTO ensemble(client_host,path,info_hash,ensemble,element) SELECT NULL,path,NULL,?, '1' FROM data",
			[`alternate-${member}`],
		);
	}
	if (
		mode !== "refresh" ||
		clientCount !== 1 ||
		accessMode !== "mock" ||
		fixturePaths ||
		delayMs ||
		rootDelayMs ||
		missingEvery ||
		sourceDelayMs
	)
		throw new Error(
			"Combined harness accepts only synthetic single-client full refresh",
		);
	const aliases = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];
	if (![1, 5].includes(memberships))
		throw new Error("Expected one or five aliases");
	const title =
		aliases
			.slice(0, memberships === 1 ? 1 : memberships - 1)
			.map((alias) => `Review Show ${alias}`)
			.join(" AKA ") + " S01E01.mkv";
	const catalog = Array.from({ length: count }, (_, index) => ({
		hash: index.toString(16).padStart(40, "0"),
		infohash_v1: index.toString(16).padStart(40, "0"),
		name: title,
		save_path: fixtureRoot,
		category: "fixture",
		tags: "fixture",
		total_size: 4096 + fileCount - 1,
		state: "uploading",
		trackers: [],
		files: Array.from({ length: fileCount }, (_, file) => ({
			name: file
				? `extra-${String(file).padStart(5, "0")}.mkv`
				: String(index).padStart(9, "0"),
			size: file ? 1 : 4096,
			index: file,
			progress: 1,
			priority: 1,
		})),
	}));
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, options = {}) => {
		const parsed = new URL(String(url));
		if (parsed.hostname !== "qb-fixture.invalid") {
			if (
				parsed.hostname === "127.0.0.1" &&
				parsed.pathname === "/api/ping"
			)
				return originalFetch(url, options);
			throw new Error(
				`Unexpected external transport: ${parsed.hostname}`,
			);
		}
		const route = parsed.pathname.replace("/api/v2", "");
		adapter.routes[route] = (adapter.routes[route] ?? 0) + 1;
		adapter.requestBytes += Buffer.byteLength(String(options.body ?? ""));
		let body;
		if (route === "/auth/login") body = "Ok.";
		else if (route === "/app/version") body = "v5.1.0";
		else if (route === "/torrents/info") {
			const params = new URLSearchParams(options.body);
			if (
				params.get("includeFiles") !== "true" ||
				params.get("includeTrackers") !== "true" ||
				params.has("hashes")
			)
				throw new Error("Unexpected full-refresh catalog contract");
			refreshCalls++;
			refreshedSearchees += catalog.length;
			// Transport encoding and adapter decoding both run inside the timed call.
			body = JSON.stringify(catalog);
		} else throw new Error(`Unexpected qB endpoint ${route}`);
		adapter.responseBytes += Buffer.byteLength(body);
		return new Response(body, {
			status: 200,
			headers: { "Set-Cookie": "SID=fixture" },
		});
	};
	const { setClientsForTesting } = await importSource(
		"clients/TorrentClient",
	);
	const { default: QBittorrent } = await importSource("clients/QBittorrent");
	const client = new QBittorrent(
		"http://qb-fixture.invalid",
		"synthetic-client",
		0,
		false,
	);
	await client.login();
	setClientsForTesting([client]);
	// Populate the same warm full-JSON cache through the real adapter before timing.
	await client.getClientSearchees({
		refresh: [],
		includeFiles: true,
		includeTrackers: true,
	});
	refreshCalls = 0;
	refreshedSearchees = 0;
	adapter.routes = {};
	adapter.requestBytes = 0;
	adapter.responseBytes = 0;

	await db("data").insert({
		path: join(fixtureRoot, "missing-obsolete"),
		title: "Obsolete fixture",
	});
	await db("ensemble").insert({
		client_host: null,
		path: join(fixtureRoot, "missing-obsolete"),
		info_hash: null,
		ensemble: "obsolete",
		element: "1",
	});
	const expiredHash = "e".repeat(40);
	const expiredPath = join(
		configDir,
		"torrent_cache",
		`${expiredHash}.cached.torrent`,
	);
	fs.writeFileSync(
		expiredPath,
		bencode.encode({
			announce: "https://fixture.invalid/announce",
			info: {
				name: "fixture",
				length: 1,
				"piece length": 16384,
				pieces: Buffer.alloc(20),
			},
		}),
	);
	await db("decision").insert({
		guid: "expired-fixture",
		info_hash: expiredHash,
		decision: "MATCH",
		last_seen: Date.now() - 400 * 24 * 60 * 60 * 1000,
	});
	const plans = await db.raw(
		"EXPLAIN QUERY PLAN SELECT path FROM data WHERE path > ? UNION SELECT path FROM ensemble WHERE path > ? ORDER BY path ASC LIMIT 512",
		[join(fixtureRoot, "000000001"), join(fixtureRoot, "000000001")],
	);
	const portPicker = createServer();
	await new Promise((done) => portPicker.listen(0, "127.0.0.1", done));
	const port = portPicker.address().port;
	await new Promise((done) => portPicker.close(done));
	const { serve } = await importSource("server");
	let listening;
	const ready = new Promise((done) => {
		listening = done;
	});
	const serving = serve(port, "127.0.0.1", "", listening);
	await ready;
	const ping = fork(
		new URL(import.meta.url),
		["ping", `http://127.0.0.1:${port}/api/ping`],
		{ stdio: ["ignore", "ignore", "inherit", "ipc"] },
	);
	await new Promise((done) => setTimeout(done, 100));
	const pingResult = new Promise((done) =>
		ping.on("message", (message) => {
			if (message?.ping) done(message);
		}),
	);
	let sqlCalls = 0;
	let sqlMs = 0;
	let maxStatementMs = 0;
	let applyMs = 0;
	let firstPathQuery;
	const pendingQueries = new Map();
	db.on("query", (q) => {
		sqlCalls++;
		if (/^insert into [`"]client_searchee/i.test(q.sql))
			adapter.insertBindingBytes += (q.bindings ?? []).reduce(
				(sum, value) =>
					sum +
					(typeof value === "string" ? Buffer.byteLength(value) : 0),
				0,
			);
		if (
			!firstPathQuery &&
			/^select .*path.*from.*(?:data|ensemble)/i.test(q.sql)
		) {
			firstPathQuery = { sql: q.sql, bindings: q.bindings };
		}
		pendingQueries.set(q.__knexQueryUid, performance.now());
	});
	db.on("query-response", (returned, q) => {
		if (/^select /i.test(q.sql) && /client_searchee/i.test(q.sql)) {
			for (const row of Array.isArray(returned) ? returned : [returned])
				if (typeof row?.files === "string")
					adapter.fileJsonReadBytes += Buffer.byteLength(row.files);
		}
		const started = pendingQueries.get(q.__knexQueryUid);
		if (started !== undefined) {
			const duration = performance.now() - started;
			sqlMs += duration;
			maxStatementMs = Math.max(maxStatementMs, duration);
			if (/^INSERT INTO ensemble/i.test(q.sql)) applyMs += duration;
		}
		pendingQueries.delete(q.__knexQueryUid);
	});
	const loop = monitorEventLoopDelay({ resolution: 5 });
	loop.enable();
	await new Promise((done) => setTimeout(done, 20));
	const pre = process.memoryUsage();
	const peak = { ...pre };
	const sample = () => {
		for (const [key, value] of Object.entries(process.memoryUsage()))
			peak[key] = Math.max(peak[key], value);
	};
	const memoryTimer = setInterval(sample, 5);
	await new Promise((done) => {
		ping.once("message", done);
		ping.send("begin");
	});
	const sqlProbeTimes = [];
	let probePending = false;
	const probeTimer = setInterval(async () => {
		if (probePending) return;
		probePending = true;
		const t = performance.now();
		try {
			await db("ensemble").count("* as n");
			sqlProbeTimes.push(performance.now() - t);
		} finally {
			probePending = false;
		}
	}, 5);
	const eluStart = performance.eventLoopUtilization();
	const cpuStart = process.cpuUsage();
	const operationMs = [];
	for (let iteration = 0; iteration < repeats; iteration++) {
		const start = performance.now();
		if (mode === "index") {
			const { indexTorrentsAndDataDirs } = await importSource("torrent");
			await indexTorrentsAndDataDirs({ startup: true });
		} else await cleanupDB();
		operationMs.push(performance.now() - start);
		sample();
	}
	const cpu = process.cpuUsage(cpuStart);
	const measuredMaxRssKiB = process.resourceUsage().maxRSS;
	const elu = performance.eventLoopUtilization(eluStart);
	clearInterval(probeTimer);
	while (probePending) await new Promise((done) => setTimeout(done, 1));
	clearInterval(memoryTimer);
	// Let the monitor observe a timer delayed by a synchronous cleanup burst.
	await new Promise((done) => setTimeout(done, 10));
	loop.disable();
	ping.send("stop");
	const http = await pingResult;
	const measuredAdapter = structuredClone(adapter);
	const cleanupSqlCalls = sqlCalls;
	const cleanupSqlMs = sqlMs;
	const actualPathPlan = firstPathQuery
		? await db.raw(
				`EXPLAIN QUERY PLAN ${firstPathQuery.sql}`,
				firstPathQuery.bindings,
			)
		: [];
	const crypto = await import("node:crypto");
	const digest = crypto.createHash("sha256");
	for (const row of await db("ensemble")
		.select("client_host", "path", "info_hash", "ensemble", "element")
		.orderByRaw("rowid"))
		digest.update(JSON.stringify(row) + "\n");
	const membershipDigest = digest.digest("hex");
	const dataDigest = crypto.createHash("sha256");
	for (const row of await db("data").select("path", "title").orderBy("path"))
		dataDigest.update(JSON.stringify(row) + "\n");
	const cacheDigest = crypto.createHash("sha256");
	const cacheRows = await db("client_searchee")
		.select("*")
		.orderBy("client_host")
		.orderBy("info_hash");
	for (const row of cacheRows) cacheDigest.update(JSON.stringify(row) + "\n");
	if (cacheRows.length !== count) throw new Error("Cache row count differs");
	const integrity = await db.raw("PRAGMA integrity_check");
	const remainingData = await db("data").count({ n: "*" }).first();
	const remainingEnsemble = await db("ensemble").count({ n: "*" }).first();
	const expiredDecision = await db("decision")
		.where("info_hash", expiredHash)
		.first();
	if (
		remainingData.n !== count ||
		remainingEnsemble.n !== count ||
		expiredDecision ||
		fs.existsSync(expiredPath)
	)
		throw new Error("Combined cleanup output differs");
	if (
		globalThis.__combinedPerf.generatedSources !== count * repeats ||
		globalThis.__combinedPerf.generatedRows !==
			count * memberships * repeats
	)
		throw new Error(
			`Actual generator fixture alias count differs: ${JSON.stringify(globalThis.__combinedPerf)} expected sources=${count * repeats} rows=${count * memberships * repeats}`,
		);
	if (
		accessMode === "real" &&
		(remainingData.n !== count ||
			remainingEnsemble.n !== count * memberships)
	)
		throw new Error(
			"Real fixture changed or became inaccessible; row counts differ",
		);
	// Explain with original bindings, but publish no private filesystem paths.
	if (firstPathQuery && accessMode === "real")
		firstPathQuery.bindings = firstPathQuery.bindings.map((value) =>
			typeof value === "string" && value.startsWith(fixtureRoot)
				? "<private-fixture-path>"
				: value,
		);
	const result = {
		scope: "actual compiled cleanupDB, actual qB full-refresh adapter and full-JSON SQLite writes, actual generator/staging/pruning/housekeeping, production serve()/api/ping; warm migrated in-memory SQLite and synthetic fetch/filesystem transport; prepared source catalog outside timing, transport JSON encode/decode inside timing",
		gitSha:
			process.env.BENCH_GIT_SHA ??
			execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: root,
				encoding: "utf8",
			}).trim(),
		sourceSha256: (await import("node:crypto"))
			.createHash("sha256")
			.update(fs.readFileSync(join(root, "cross-seed/src/db.ts")))
			.digest("hex"),
		compiledSha256: (await import("node:crypto"))
			.createHash("sha256")
			.update(fs.readFileSync(join(root, "cross-seed/dist/db.js")))
			.digest("hex"),
		sourceIdentities: Object.fromEntries(
			[
				"db",
				"torrent",
				"ensembleWriter",
				"searchee",
				"clients/QBittorrent",
				"clients/clientCache",
				"clients/TorrentClient",
				"healthGeneration",
				"server",
				"routes/baseApi",
			].flatMap((name) =>
				["src", "dist"].map((folder) => {
					const path = join(
						root,
						"cross-seed",
						folder,
						name + (folder === "src" ? ".ts" : ".js"),
					);
					return [
						`${folder}/${name}`,
						fs.existsSync(path)
							? crypto
									.createHash("sha256")
									.update(fs.readFileSync(path))
									.digest("hex")
							: null,
					];
				}),
			),
		),
		workerSha256: crypto
			.createHash("sha256")
			.update(fs.readFileSync(new URL(import.meta.url)))
			.digest("hex"),
		lockSha256: crypto
			.createHash("sha256")
			.update(fs.readFileSync(join(root, "package-lock.json")))
			.digest("hex"),
		membershipDigest,
		dataRowDigest: dataDigest.digest("hex"),
		cacheRowDigest: cacheDigest.digest("hex"),
		cacheRows: cacheRows.length,
		adapter: measuredAdapter,
		cacheFileJsonBytes: cacheRows.reduce(
			(sum, row) => sum + Buffer.byteLength(row.files),
			0,
		),
		housekeeping: {
			expiredCacheRemoved: true,
			expiredDecisionRemoved: true,
			obsoletePathRemoved: true,
		},
		generation: globalThis.__combinedPerf,
		elu,
		sqlReaderLatencyMs: quantiles(sqlProbeTimes),
		node: process.version,
		cpuModel: cpus()[0].model,
		platform: platform(),
		arch: arch(),
		sqlite: await db.raw("SELECT sqlite_version() AS version"),
		fixture: {
			count,
			fileCount,
			clientCount,
			sourceDelayMs,
			memberships,
			delayMs,
			repeats,
			missing: missingEvery ? Math.ceil(count / missingEvery) : 0,
			mode,
			missingEvery,
			accessMode,
		},
		refresh: { calls: refreshCalls, searchees: refreshedSearchees },
		wallMs: quantiles(operationMs),
		coldWallMs: operationMs[0],
		warmWallMs: quantiles(operationMs.slice(1)),
		cpuUs: cpu,
		memoryBefore: pre,
		memoryPeak: peak,
		processMaxRssKiB: measuredMaxRssKiB,
		loopMs: {
			p95: loop.percentile(95) / 1e6,
			p99: loop.percentile(99) / 1e6,
			max: loop.max / 1e6,
		},
		fs: {
			accessCalls: calls,
			rootGuardAccessCalls,
			maxConcurrency: peakActive,
			rootGuardDelayMs: rootDelayMs,
		},
		sql: {
			calls: cleanupSqlCalls,
			durationMs: cleanupSqlMs,
			maxStatementMs,
			applyMs,
			firstPathQuery,
			actualPathPlan,
			referenceMergePlan: plans,
		},
		http,
		remainingData: remainingData.n,
		remainingEnsemble: remainingEnsemble.n,
		integrity,
	};
	process.emit("SIGTERM");
	await serving;
	await db.destroy();
	await rm(configDir, { recursive: true, force: true });
	globalThis.fetch = originalFetch;
	fs.promises.access = originalAccess;
	syncBuiltinESMExports();
	console.log(`BENCH_RESULT ${JSON.stringify(result)}`);
}
