// Actual compiled cleanupDB + migrated SQLite + production HTTP server.
// All cached paths and access delays are synthetic. This does not measure NFS.
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, cpus, platform, arch } from "node:os";
import { resolve, join, dirname, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { syncBuiltinESMExports } from "node:module";
import { fork, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";

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
	process.send({ ping: quantiles(times), errors, bytes });
	process.disconnect();
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
		fixtureRoot = "/synthetic/root",
		pathListArg,
	] = process.argv.slice(2);
	const root = resolve(checkout);
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
					!path.startsWith(`${fixtureRoot}/`),
			))
	)
		throw new Error("Invalid private path fixture");
	const fixturePathSet = fixturePaths ? new Set(fixturePaths) : null;
	if (!["cleanup", "refresh", "index"].includes(mode))
		throw new Error("Unknown worker mode");
	const fileCount = Number(process.env.BENCH_FILES ?? 1);
	const clientCount = Number(process.env.BENCH_CLIENTS ?? 1);
	const sourceDelayMs = Number(process.env.BENCH_SOURCE_DELAY ?? 0);
	const fixtureTitle =
		(memberships === 1
			? "Review Show 0"
			: memberships === 2
				? "Review Show 0 AKA"
				: Array.from(
						{ length: memberships - 1 },
						(_, alias) => `Review Show ${alias}`,
					).join(" AKA ")) + " S01E01.mkv";
	let refreshCalls = 0;
	let refreshedSearchees = 0;
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
				: String(path).startsWith(`${fixtureRoot}/`))
		)
			return originalAccess(path, ...args);
		calls++;
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
			`WITH RECURSIVE numbers(n) AS (SELECT 0 WHERE ? > 0 UNION ALL SELECT n+1 FROM numbers WHERE n+1 < ?) INSERT INTO data(path,title) SELECT ? || '/' || printf('%09d', n), 'Synthetic fixture' FROM numbers`,
			[count, count, fixtureRoot],
		);
	}
	for (let member = 0; mode === "cleanup" && member < memberships; member++) {
		await db.raw(
			"INSERT INTO ensemble(client_host,path,info_hash,ensemble,element) SELECT NULL,path,NULL,?, '1' FROM data",
			[`alternate-${member}`],
		);
	}
	if (mode === "refresh" || mode === "index") {
		const { setClientsForTesting } = await importSource(
			"clients/TorrentClient",
		);
		const { resultOf } = await importSource("Result");
		const clients = Array.from({ length: clientCount }, (_, member) => {
			const clientHost = `synthetic-client-${member}`;
			const searchees = Array.from({ length: count }, (_, index) => ({
				name: "Review.Show.S01E01.mkv",
				title: fixtureTitle,
				infoHash: (member * count + index)
					.toString(16)
					.padStart(40, "0"),
				clientHost,
				savePath: fixturePaths
					? dirname(fixturePaths[index])
					: fixtureRoot,
				trackers: [],
				length: 1024,
				files: [
					{
						name: fixturePaths
							? basename(fixturePaths[index])
							: String(index).padStart(9, "0"),
						path: fixturePaths
							? basename(fixturePaths[index])
							: String(index).padStart(9, "0"),
						length: 1024,
					},
				],
			}));
			for (const source of searchees) {
				if (sourceDelayMs) source.savePath = undefined;
				for (let i = 1; i < fileCount; i++)
					source.files.push({
						name: `extra-${i}`,
						path: `extra-${i}`,
						length: 1,
					});
			}
			return {
				clientHost,
				label: clientHost,
				async getDownloadDir() {
					await new Promise((done) =>
						setTimeout(done, sourceDelayMs),
					);
					return resultOf(fixtureRoot);
				},
				async getClientSearchees(options) {
					if (
						(mode === "refresh" && options.refresh?.length !== 0) ||
						!options.includeFiles ||
						!options.includeTrackers
					)
						throw new Error("Invalid refresh contract");
					refreshCalls++;
					refreshedSearchees += searchees.length;
					return { searchees, newSearchees: searchees };
				},
			};
		});
		setClientsForTesting(clients);
	}
	const plans = await db.raw(
		"EXPLAIN QUERY PLAN SELECT path FROM data WHERE path > ? UNION SELECT path FROM ensemble WHERE path > ? ORDER BY path ASC LIMIT 512",
		[`${fixtureRoot}/000000001`, `${fixtureRoot}/000000001`],
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
	const { createEnsemblePieces } = await importSource("torrent");
	const parsedAliasCount =
		createEnsemblePieces(fixtureTitle, [
			{ name: "synthetic", path: "synthetic", length: 1 },
		])?.length ?? 0;
	if (mode !== "cleanup" && parsedAliasCount !== memberships)
		throw Error(
			`Fixture parsed${parsedAliasCount} aliases,expected${memberships}`,
		);
	let writtenMembershipRows = 0;
	let sqlCalls = 0;
	let sqlMs = 0;
	let maxStatementMs = 0;
	let applyMs = 0;
	let firstPathQuery;
	const pendingQueries = new Map();
	db.on("query", (q) => {
		sqlCalls++;
		if (/^insert into [`"]ensemble_stage_/i.test(q.sql))
			writtenMembershipRows += q.bindings.length / 6;
		else if (/^insert into [`"]ensemble[`"] /i.test(q.sql))
			writtenMembershipRows += q.bindings.length / 5;
		if (
			!firstPathQuery &&
			/^select .*path.*from.*(?:data|ensemble)/i.test(q.sql)
		) {
			firstPathQuery = { sql: q.sql, bindings: q.bindings };
		}
		pendingQueries.set(q.__knexQueryUid, performance.now());
	});
	db.on("query-response", (_, q) => {
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
	const integrity = await db.raw("PRAGMA integrity_check");
	const remainingData = await db("data").count({ n: "*" }).first();
	const remainingEnsemble = await db("ensemble").count({ n: "*" }).first();
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
		scope: `actual compiled cleanupDB and optional fake-client refresh through real ensemble rebuilding, production serve()/api/ping, migrated in-memory SQLite; filesystem access=${accessMode}; private paths omitted`,
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
			["db", "torrent", "ensembleWriter"].flatMap((name) =>
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
		lockSha256: crypto
			.createHash("sha256")
			.update(fs.readFileSync(join(root, "package-lock.json")))
			.digest("hex"),
		membershipDigest,
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
			writtenMembershipRows,
			parsedAliasCount,
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
	fs.promises.access = originalAccess;
	syncBuiltinESMExports();
	console.log(`BENCH_RESULT ${JSON.stringify(result)}`);
}
