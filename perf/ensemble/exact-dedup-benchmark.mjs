// Node >=26, with experimental module mocking for isolated filesystem/assessment
// instrumentation. No client or indexer is contacted. Run after compiling base:
// node --experimental-test-module-mocks perf/ensemble/exact-dedup-benchmark.mjs
//   BASE_CHECKOUT OUTPUT [--quick]
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { registerHooks } from "node:module";
import { mock } from "node:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { get } from "node:http";
import { constants as fsConstants } from "node:fs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const script = fileURLToPath(import.meta.url);

async function worker(checkout, variant, spec, fixtureDirectory) {
	const setupStart = performance.now();
	const root = await fs.mkdtemp(join(tmpdir(), "exact-ensemble-bench-"));
	const databasePath = join(root, "cross-seed.db");
	let fixtureMetadata;
	if (fixtureDirectory && !spec.seedOnly) {
		fixtureMetadata = JSON.parse(
			await fs.readFile(join(fixtureDirectory, "metadata.json"), "utf8"),
		);
		await fs.copyFile(
			join(fixtureDirectory, "fixture.db"),
			databasePath,
			fsConstants.COPYFILE_FICLONE,
		);
		if (
			hash(await fs.readFile(databasePath)) !==
			fixtureMetadata.databaseSha256
		)
			throw Error("Disposable fixture copy checksum differs");
	}
	process.env.CONFIG_DIR = root;
	const dist = join(checkout, "cross-seed/dist");
	const pipelineUrl = pathToFileURL(join(dist, "pipeline.js")).href;
	const original = await fs.readFile(join(dist, "pipeline.js"), "utf8");
	let transformed = original;
	if (variant === "sql") {
		const marker = '.orderBy("rowid")';
		if (!original.includes(marker))
			throw Error("SQL exploration marker absent");
		transformed = original.replace(
			marker,
			'.groupBy(["client_host", "path", "info_hash", "ensemble", "element"]).orderByRaw("MIN(rowid)")',
		);
	} else if (variant === "js") {
		const marker = "const path = entry.path;";
		if (!original.includes(marker))
			throw Error("JS exploration marker absent");
		transformed = original
			.replace(
				"const duplicateFiles = new Set();",
				"const memberships = new Set();\n    const duplicateFiles = new Set();",
			)
			.replace(
				marker,
				"const identity = JSON.stringify([entry.client_host, entry.path, entry.info_hash, entry.ensemble, entry.element]);\n        if (memberships.has(identity)) return acc;\n        memberships.add(identity);\n        const path = entry.path;",
			);
		if (transformed === original)
			throw Error("JS exploration transform failed");
	}
	const hook = registerHooks({
		load(url, context, nextLoad) {
			if (url === pipelineUrl)
				return {
					format: "module",
					source: transformed,
					shortCircuit: true,
				};
			return nextLoad(url, context);
		},
	});
	const load = (file) => import(pathToFileURL(join(dist, file)).href);
	let accessCount = 0;
	let statCount = 0;
	let active = false;
	const fixturePath = join(fixtureDirectory ?? root, "episode.mkv");
	const alternativePath = join(fixtureDirectory ?? root, "alternative.mkv");
	if (!fixtureDirectory || spec.seedOnly) {
		await fs.writeFile(fixturePath, "episode");
		await fs.writeFile(alternativePath, "episode");
	}
	const fixtureStat = await fs.stat(fixturePath);
	const nativeAccess = fs.access;
	const nativeStat = fs.stat;
	const pause = () => new Promise((r) => setTimeout(r, spec.delayMs));
	const fsMock = mock.module("node:fs/promises", {
		exports: {
			default: fs,
			...fs,
			access: async (...args) => {
				if (
					active &&
					[fixturePath, alternativePath].includes(args[0])
				) {
					accessCount++;
					if (spec.delayMs) await pause();
					if (spec.filesystem === "constant") return;
				}
				return nativeAccess(...args);
			},
			stat: async (...args) => {
				if (
					active &&
					[fixturePath, alternativePath].includes(args[0])
				) {
					statCount++;
					if (spec.delayMs) await pause();
					if (spec.filesystem === "constant") return fixtureStat;
				}
				return nativeStat(...args);
			},
		},
	});
	const assessments = [];
	const decide = await load("decide.js");
	const assessmentMock = mock.module(
		pathToFileURL(join(dist, "decide.js")).href,
		{
			exports: {
				...decide,
				assessCandidateCaching: async (_candidate, searchee) => {
					assessments.push({
						name: searchee.name,
						length: searchee.length,
						clientHost: searchee.clientHost,
						infoHash: searchee.infoHash,
						files: searchee.files.map((f) => ({
							...f,
							path:
								f.path === fixturePath
									? "/synthetic/episode.mkv"
									: "/synthetic/alternative.mkv",
						})),
					});
					return { decision: "SIZE_MISMATCH" };
				},
			},
		},
	);
	const { db } = await load("db.js");
	db.client.connectionSettings.filename = databasePath;
	let server;
	let pingUrl;
	const pingMs = [];
	const pings = new Set();
	const ping = () => {
		const start = performance.now();
		const pending = new Promise((resolvePing, reject) => {
			get(pingUrl, (res) => {
				let body = "";
				res.on("data", (chunk) => {
					body += chunk;
				});
				res.on("end", () => {
					if (res.statusCode !== 200 || body !== "OK") {
						reject(
							Error("Compiled /api/ping did not return 200 OK"),
						);
						return;
					}
					pingMs.push(performance.now() - start);
					resolvePing();
				});
			}).on("error", reject);
		});
		pings.add(pending);
		pending.finally(() => pings.delete(pending));
	};
	let pingTimer;
	try {
		const { createAppDirHierarchy, getDefaultRuntimeConfig } =
			await load("configuration.js");
		const { setRuntimeConfig } = await load("runtimeConfig.js");
		const logging = await load("logger.js");
		const { initializeLogger, Label } = logging;
		createAppDirHierarchy();
		initializeLogger({ verbose: false });
		logging.logger.silent = true;
		setRuntimeConfig({
			...getDefaultRuntimeConfig(),
			seasonFromEpisodes: 1,
			useClientTorrents: false,
			dataDirs: [],
		});
		await db.migrate.latest();
		const aliases = [
			"Zulu.Show",
			"Alpha.Show",
			"Beta.Show",
			"Gamma.Show",
			"Delta.Show",
		].slice(0, spec.aliases);
		const keys = aliases.map(
			(s) => `${s.replaceAll(".", "").toLowerCase()}.S1`,
		);
		const connection = await db.client.acquireConnection();
		if (!fixtureMetadata) {
			const insert = connection.prepare(
				"INSERT INTO ensemble(client_host,path,info_hash,ensemble,element) VALUES (?,?,?,?,?)",
			);
			connection.exec("BEGIN");
			for (let i = 0; i < spec.totalRows; i++) {
				const selected = i < spec.selectedRows;
				const membership = Math.floor(i / spec.repeats);
				insert.run(
					null,
					membership % 2 ? alternativePath : fixturePath,
					`synthetic-${membership}`,
					selected ? keys[membership % keys.length] : "unrelated.S1",
					"1",
				);
			}
			connection.exec("COMMIT");
		}
		const sqlite = connection
			.prepare("SELECT sqlite_version() AS v")
			.get().v;
		const initialRows = connection
			.prepare("SELECT COUNT(*) AS n FROM ensemble")
			.get().n;
		if (initialRows !== spec.totalRows)
			throw Error("Fixture row count differs");
		if (spec.seedOnly) {
			connection.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			const schema = connection
				.prepare("SELECT name,sql FROM sqlite_master ORDER BY name")
				.all();
			const rowHash = createHash("sha256");
			for (const row of connection
				.prepare("SELECT * FROM ensemble ORDER BY rowid")
				.iterate())
				rowHash.update(JSON.stringify(row));
			await db.client.releaseConnection(connection);
			const bytes = await fs.readFile(databasePath);
			await fs.writeFile(join(fixtureDirectory, "fixture.db"), bytes);
			const metadata = {
				databaseSha256: hash(bytes),
				ensembleRowsSha256: rowHash.digest("hex"),
				schemaSha256: hash(JSON.stringify(schema)),
				initialRows,
				node: process.version,
				sqlite,
				basePipelineSha256: hash(original),
				spec: { ...spec, seedOnly: undefined },
			};
			await fs.writeFile(
				join(fixtureDirectory, "metadata.json"),
				JSON.stringify(metadata, null, 2),
			);
			return metadata;
		}
		await db.client.releaseConnection(connection);
		const { default: Fastify } = await import(
			pathToFileURL(join(checkout, "node_modules/fastify/fastify.js"))
				.href
		);
		const { baseApiPlugin } = await load("routes/baseApi.js");
		server = Fastify({ logger: false });
		server.removeAllContentTypeParsers();
		await server.register(baseApiPlugin, { prefix: "/api" });
		const origin = await server.listen({ port: 0, host: "127.0.0.1" });
		pingUrl = `${origin}/api/ping`;
		const preflight = await fetch(pingUrl);
		if (preflight.status !== 200 || (await preflight.text()) !== "OK")
			throw Error("Compiled /api/ping preflight failed");
		let query;
		db.on("query", (q) => {
			if (/select .*from [`"]ensemble[`"] where/.test(q.sql))
				query = { sql: q.sql, bindings: q.bindings };
		});
		const { checkNewCandidateMatch } = await load("pipeline.js");
		const setupMs = performance.now() - setupStart;
		const setupMaxRssKb = process.resourceUsage().maxRSS;
		const lag = monitorEventLoopDelay({ resolution: 10 });
		lag.enable();
		await new Promise((r) => setTimeout(r, 20));
		const memoryBefore = process.memoryUsage();
		const cpu = process.cpuUsage();
		const utilization = performance.eventLoopUtilization();
		const start = performance.now();
		ping();
		pingTimer = setInterval(ping, 10);
		active = true;
		await checkNewCandidateMatch(
			{
				name: `${aliases.join(".AKA.")}.S01.1080p.WEB`,
				guid: "synthetic",
				link: "http://unused.invalid",
				tracker: "synthetic",
			},
			Label.RSS,
		);
		active = false;
		const wallMs = performance.now() - start;
		const usage = process.cpuUsage(cpu);
		const memoryAfter = process.memoryUsage();
		const maxRssKb = process.resourceUsage().maxRSS;
		const loopUtilization = performance.eventLoopUtilization(utilization);
		clearInterval(pingTimer);
		await Promise.all(pings);
		await new Promise((r) => setTimeout(r, 20));
		lag.disable();
		if (!assessments.length || !query)
			throw Error("Compiled public pipeline did not assess fixture");
		const expectedAccess =
			variant === "base"
				? spec.selectedRows
				: Math.ceil(spec.selectedRows / spec.repeats);
		if (accessCount !== expectedAccess)
			throw Error(
				`Unexpected access probes: ${accessCount}, expected ${expectedAccess}`,
			);
		if (statCount !== expectedAccess + 1)
			throw Error(
				`Unexpected stat probes: ${statCount}, expected ${expectedAccess + 1}`,
			);
		if (
			assessments.some(
				(a) =>
					a.files.length !== 1 ||
					a.files[0].path !== "/synthetic/episode.mkv",
			)
		)
			throw Error("First physical source changed");
		// Verify full tuple identity independently after the timed public pipeline.
		// SQL grouping must retain the first row of each tuple in rowid order.
		const returnedRows = await db.raw(query.sql, query.bindings);
		const identities = new Set();
		const tuples = [];
		for (const row of returnedRows) {
			const tuple = [
				row.client_host,
				row.path === fixturePath
					? "/synthetic/episode.mkv"
					: "/synthetic/alternative.mkv",
				row.info_hash,
				row.ensemble,
				row.element,
			];
			const key = JSON.stringify(tuple);
			if (identities.has(key)) continue;
			identities.add(key);
			tuples.push(tuple);
		}
		const checksums = {};
		for (const file of [
			"package-lock.json",
			"cross-seed/src/pipeline.ts",
			"cross-seed/dist/pipeline.js",
			"cross-seed/dist/db.js",
			"cross-seed/dist/searchee.js",
			"cross-seed/dist/utils.js",
			"cross-seed/src/routes/baseApi.ts",
			"cross-seed/dist/routes/baseApi.js",
		])
			checksums[file] = hash(await fs.readFile(join(checkout, file)));
		const finalConnection = await db.client.acquireConnection();
		const finalRowHash = createHash("sha256");
		for (const row of finalConnection
			.prepare("SELECT * FROM ensemble ORDER BY rowid")
			.iterate())
			finalRowHash.update(JSON.stringify(row));
		const finalEnsembleRowsSha256 = finalRowHash.digest("hex");
		await db.client.releaseConnection(finalConnection);
		if (
			fixtureMetadata &&
			finalEnsembleRowsSha256 !== fixtureMetadata.ensembleRowsSha256
		)
			throw Error("Lookup changed stored ensemble rows");
		if (
			fixtureDirectory &&
			hash(await fs.readFile(join(fixtureDirectory, "fixture.db"))) !==
				fixtureMetadata.databaseSha256
		)
			throw Error("Worker mutated original fixture");
		return {
			variant,
			spec,
			node: process.version,
			sqlite,
			wallMs,
			setupMs,
			setupMaxRssKb,
			fixtureMetadata,
			initialRows,
			finalRows: (await db("ensemble").count({ n: "*" }).first()).n,
			finalEnsembleRowsSha256,
			checkoutHead: execFileSync(
				"git",
				["-C", checkout, "rev-parse", "HEAD"],
				{ encoding: "utf8" },
			).trim(),
			checksums,
			cpuMs: (usage.user + usage.system) / 1000,
			accessCount,
			statCount,
			assessmentsSha256: hash(JSON.stringify(assessments)),
			distinctTuplesSha256: hash(JSON.stringify(tuples)),
			distinctTupleCount: tuples.length,
			assessmentCount: assessments.length,
			memoryBefore,
			memoryAfter,
			maxRssKb,
			loopUtilization,
			pingMs,
			pingEndpoint: "compiled baseApiPlugin /api/ping over loopback",
			loopDelayP95Ms: lag.percentile(95) / 1e6,
			loopDelayP99Ms: lag.percentile(99) / 1e6,
			query,
			queryPlan: await db.raw(
				`EXPLAIN QUERY PLAN ${query.sql}`,
				query.bindings,
			),
			originalPipelineSha256: hash(original),
			executedPipelineSha256: hash(transformed),
		};
	} finally {
		clearInterval(pingTimer);
		await Promise.all(pings);
		if (server) await server.close();
		await db.destroy();
		assessmentMock.restore();
		fsMock.restore();
		hook.deregister();
		await fs.rm(root, { recursive: true, force: true });
	}
}

if (process.argv[2] === "--worker") {
	const result = await worker(
		resolve(process.argv[3]),
		process.argv[4],
		JSON.parse(process.argv[5]),
		process.argv[6],
	);
	process.stdout.write(JSON.stringify(result));
} else {
	const checkout = resolve(process.argv[2]);
	const output = resolve(process.argv[3]);
	const quick = process.argv.includes("--quick");
	const pilot = process.argv.includes("--pilot");
	const headIndex = process.argv.indexOf("--final-head");
	const finalHead =
		headIndex < 0 ? undefined : resolve(process.argv[headIndex + 1]);
	const variants = finalHead
		? ["base", "head", "base"]
		: ["base", "js", "base", "sql", "base"];
	const matrix = [];
	for (const aliases of quick || pilot ? [2] : [1, 2, 5]) {
		for (const repeats of [1, 10])
			matrix.push({
				totalRows: quick ? 100 : 1000000,
				selectedRows: quick ? 100 : 1000000,
				aliases,
				repeats,
				delayMs: 0,
				filesystem: "constant",
			});
		for (const delayMs of quick ? [] : pilot ? [50] : [0, 5, 50])
			matrix.push({
				totalRows: 1000000,
				selectedRows: 20,
				aliases,
				repeats: 10,
				delayMs,
				filesystem: "real",
			});
	}
	await fs.mkdir(output, { recursive: true });
	const samples = [];
	const captureWorker = async (kind, spec, variant, round, child) => {
		const directory = join(output, "workers");
		await fs.mkdir(directory, { recursive: true });
		await fs.writeFile(
			join(
				directory,
				`${kind}-${hash(JSON.stringify(spec)).slice(0, 16)}-${round}-${variant}-${Date.now()}.json`,
			),
			JSON.stringify(
				{
					kind,
					spec,
					variant,
					round,
					status: child.status,
					signal: child.signal,
					error: child.error?.message,
					errorCode: child.error?.code,
					timeoutMs: kind === "seed" ? 180000 : 120000,
					stdout: child.stdout,
					stderr: child.stderr,
					driverSha256: hash(await fs.readFile(script)),
					node: process.version,
				},
				null,
				2,
			),
		);
	};
	for (const spec of matrix) {
		const fixtureDirectory = join(
			output,
			"fixtures",
			hash(
				JSON.stringify({ ...spec, delayMs: 0, filesystem: undefined }),
			).slice(0, 16),
		);
		await fs.mkdir(fixtureDirectory, { recursive: true });
		try {
			await fs.access(join(fixtureDirectory, "metadata.json"));
		} catch {
			const seed = spawnSync(
				process.execPath,
				[
					"--experimental-test-module-mocks",
					script,
					"--worker",
					checkout,
					"base",
					JSON.stringify({ ...spec, seedOnly: true }),
					fixtureDirectory,
				],
				{
					encoding: "utf8",
					maxBuffer: 16 * 1024 * 1024,
					timeout: 180000,
					killSignal: "SIGTERM",
				},
			);
			await captureWorker("seed", spec, "base", 0, seed);
			if (seed.status !== 0) throw Error(seed.stderr || seed.stdout);
		}
		for (let round = 0; round < (quick || pilot ? 1 : 5); round++) {
			for (const variant of variants) {
				const child = spawnSync(
					process.execPath,
					[
						"--experimental-test-module-mocks",
						script,
						"--worker",
						variant === "head" ? finalHead : checkout,
						variant,
						JSON.stringify(spec),
						fixtureDirectory,
					],
					{
						encoding: "utf8",
						maxBuffer: 16 * 1024 * 1024,
						timeout: 120000,
						killSignal: "SIGTERM",
					},
				);
				await captureWorker("lookup", spec, variant, round, child);
				if (child.status !== 0)
					throw Error(child.stderr || child.stdout);
				const result = JSON.parse(child.stdout);
				samples.push({ round, ...result });
				await fs.writeFile(
					join(output, "raw.json"),
					JSON.stringify(
						{ exploratoryTransforms: !finalHead, matrix, samples },
						null,
						2,
					),
				);
				process.stdout.write(
					`${samples.length}: ${variant} ${JSON.stringify(spec)} ${result.wallMs.toFixed(1)}ms\n`,
				);
			}
		}
	}
	for (const spec of matrix) {
		const matching = samples.filter(
			(s) => JSON.stringify(s.spec) === JSON.stringify(spec),
		);
		if (
			new Set(matching.map((s) => s.assessmentsSha256)).size !== 1 ||
			new Set(matching.map((s) => s.distinctTuplesSha256)).size !== 1
		)
			throw Error("Output digest differs between variants");
	}
}
