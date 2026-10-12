// Run from the modified checkout after building BOTH checkouts with Node >=26:
// node perf/ensemble/benchmark.mjs ../baseline . OUTPUT [--selectivity-sweep]
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const measure = async (fn) => {
	const start = performance.now();
	const cpu = process.cpuUsage();
	const value = await fn();
	const usage = process.cpuUsage(cpu);
	return {
		wallMs: performance.now() - start,
		cpuMs: (usage.user + usage.system) / 1000,
		value,
	};
};
const stats = (values) => {
	const sorted = [...values].sort((a, b) => a - b);
	const p = (q) =>
		sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)];
	return {
		n: sorted.length,
		p50: p(0.5),
		p95: p(0.95),
		p99: p(0.99),
		min: sorted[0],
		max: sorted.at(-1),
	};
};

async function worker(checkout, count, selectedCount = 24) {
	const configDir = await mkdtemp(join(os.tmpdir(), "ensemble-benchmark-"));
	process.env.CONFIG_DIR = configDir;
	const load = (name) =>
		import(pathToFileURL(join(checkout, "cross-seed/dist", name)).href);
	const { db } = await load("db.js");
	// Use the production adapter and migrations with a disposable in-memory DB.
	// This bounds disk use; there is no claim of cold disk I/O performance.
	db.client.connectionSettings.filename = ":memory:";
	try {
		const { migrations } = await load("migrations/migrations.js");
		const all = await migrations.getMigrations();
		const previous = all.filter(
			(m) => m.name !== "18-ensemble-lookup-index",
		);
		const { createAppDirHierarchy, getDefaultRuntimeConfig } =
			await load("configuration.js");
		const { setRuntimeConfig } = await load("runtimeConfig.js");
		const { initializeLogger, Label } = await load("logger.js");
		createAppDirHierarchy();
		initializeLogger({ verbose: false });
		setRuntimeConfig({
			...getDefaultRuntimeConfig(),
			useClientTorrents: false,
			dataDirs: [],
			seasonFromEpisodes: 1,
		});
		await db.migrate.latest({
			migrationSource: {
				...migrations,
				getMigrations: () => Promise.resolve(previous),
			},
		});
		// Capture the actual compiled pipeline's query, including ORDER BY and keys.
		// Empty lookup guarantees no download, client access or filesystem pruning.
		let emitted;
		const capture = (query) => {
			if (/select .*from [`"]ensemble[`"] where/.test(query.sql))
				emitted = { sql: query.sql, bindings: query.bindings };
		};
		db.on("query", capture);
		const { checkNewCandidateMatch } = await load("pipeline.js");
		await checkNewCandidateMatch(
			{
				name: "Zulu.Show.AKA.Alpha.Show.S01.1080p.WEB",
				guid: "synthetic",
				link: "http://unused.invalid",
				tracker: "synthetic",
			},
			Label.RSS,
		);
		db.removeListener("query", capture);
		if (!emitted)
			throw Error("Compiled pipeline did not emit the ensemble lookup");
		const connection = await db.client.acquireConnection();
		const seedStart = performance.now();
		const insert = connection.prepare(
			"INSERT INTO ensemble(client_host,path,info_hash,ensemble,element) VALUES (?,?,?,?,?)",
		);
		connection.exec("BEGIN");
		for (let i = 0; i < count; i++)
			insert.run(
				null,
				`/synthetic/path/${Math.floor(i / 2)}`,
				null,
				i < selectedCount
					? i % 2
						? "alphashow.S1"
						: "zulushow.S1"
					: `series${i % 10000}.S1`,
				String(i % 24),
			);
		connection.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
		const seedMs = performance.now() - seedStart;
		const bytes = () =>
			Number(connection.prepare("PRAGMA page_count").get().page_count) *
			Number(connection.prepare("PRAGMA page_size").get().page_size);
		const beforeBytes = bytes();
		await db.client.releaseConnection(connection);
		const migration = await measure(() =>
			db.migrate.latest({ migrationSource: migrations }),
		);
		const conn = await db.client.acquireConnection();
		conn.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		const afterBytes =
			Number(conn.prepare("PRAGMA page_count").get().page_count) *
			Number(conn.prepare("PRAGMA page_size").get().page_size);
		const sqliteVersion = conn
			.prepare("SELECT sqlite_version() AS version")
			.get().version;
		await db.client.releaseConnection(conn);
		const plan = await db.raw(
			`EXPLAIN QUERY PLAN ${emitted.sql}`,
			emitted.bindings,
		);
		const query = () => db.raw(emitted.sql, emitted.bindings);
		const startupMemory = process.memoryUsage();
		const first = await measure(query);
		const expectedPaths = Array.from(
			{ length: selectedCount },
			(_, i) => `/synthetic/path/${Math.floor(i / 2)}`,
		);
		if (
			JSON.stringify(first.value.map((r) => r.path)) !==
			JSON.stringify(expectedPaths)
		)
			throw Error("Query membership/order changed");
		const rowsSha256 = digest(JSON.stringify(first.value));
		const verifyRows = (rows) => {
			if (digest(JSON.stringify(rows)) !== rowsSha256)
				throw Error("Query rows changed between samples");
		};
		const warm = [];
		for (let i = 0; i < 5; i++) await query();
		for (let i = 0; i < 25; i++) {
			const sample = await measure(query);
			verifyRows(sample.value);
			warm.push({ wallMs: sample.wallMs, cpuMs: sample.cpuMs });
		}
		// Attempt SQLite cache release between samples. The DB is in memory, so
		// these are cache-release samples, not a cold disk/cache benchmark.
		const releasedCache = [];
		for (let i = 0; i < 25; i++) {
			const c = await db.client.acquireConnection();
			c.exec("PRAGMA shrink_memory");
			await db.client.releaseConnection(c);
			const sample = await measure(query);
			verifyRows(sample.value);
			releasedCache.push({ wallMs: sample.wallMs, cpuMs: sample.cpuMs });
		}
		const insertSamples = [],
			upsertSamples = [];
		for (let i = 0; i < 25; i++) {
			const rows = Array.from({ length: 100 }, (_, j) => ({
				client_host: "synthetic-client",
				path: `/synthetic/write/${i}/${j}`,
				ensemble: `series${j}.S1`,
				element: String(j),
				info_hash: "synthetic-hash",
			}));
			const ins = await measure(() => db("ensemble").insert(rows));
			insertSamples.push({ wallMs: ins.wallMs, cpuMs: ins.cpuMs });
			const up = await measure(() =>
				db("ensemble")
					.insert(rows)
					.onConflict(["client_host", "path"])
					.merge(),
			);
			upsertSamples.push({ wallMs: up.wallMs, cpuMs: up.cpuMs });
		}
		const sourceFiles = [
			"src/db.ts",
			"src/pipeline.ts",
			"src/migrations/migrations.ts",
			"src/migrations/09-clientAndDataSearchees.ts",
			"dist/db.js",
			"dist/pipeline.js",
			"dist/migrations/migrations.js",
			"dist/migrations/09-clientAndDataSearchees.js",
		];
		if (all.some((m) => m.name === "18-ensemble-lookup-index"))
			sourceFiles.push(
				"src/migrations/18-ensemble-lookup-index.ts",
				"dist/migrations/18-ensemble-lookup-index.js",
			);
		const checksums = {};
		for (const file of sourceFiles)
			checksums[file] = digest(
				await readFile(join(checkout, "cross-seed", file)),
			);
		return {
			count,
			selectedCount,
			rowsSha256,
			sqliteVersion,
			query: emitted,
			plan: plan.map((row) => row.detail),
			membershipCount: first.value.length,
			orderedPaths: first.value.map((r) => r.path),
			sourceChecksums: checksums,
			lockfileSha256: digest(
				await readFile(join(checkout, "package-lock.json")),
			),
			seedMs,
			migration: { wallMs: migration.wallMs, cpuMs: migration.cpuMs },
			beforeBytes,
			afterBytes,
			indexBytes: afterBytes - beforeBytes,
			first: { wallMs: first.wallMs, cpuMs: first.cpuMs },
			warm,
			releasedCache,
			insertSamples,
			upsertSamples,
			peakRssKiB: process.resourceUsage().maxRSS,
			startupMemory,
			endMemory: process.memoryUsage(),
		};
	} finally {
		await db.destroy();
		await rm(configDir, { recursive: true, force: true });
	}
}

if (process.argv[2] === "--worker") {
	const output = process.argv[5];
	const result = await worker(
		resolve(process.argv[3]),
		Number(process.argv[4]),
		Number(process.argv[6] ?? 24),
	);
	await writeFile(output, JSON.stringify(result));
} else {
	const [baseline, modified, output, mode] = process.argv.slice(2);
	if (mode && mode !== "--selectivity-sweep")
		throw Error("Unknown benchmark mode");
	const fixtures = mode
		? [24, 1000, 10000].map((selectedCount) => ({
				count: 1000000,
				selectedCount,
			}))
		: [100000, 1000000].map((count) => ({ count, selectedCount: 24 }));
	if (!baseline || !modified || !output)
		throw Error(
			"Usage: node benchmark.mjs BASELINE MODIFIED OUTPUT [--selectivity-sweep]",
		);
	const runs = [];
	const scratch = await mkdtemp(join(os.tmpdir(), "ensemble-results-"));
	try {
		for (const { count, selectedCount } of fixtures) {
			for (let replicate = 0; replicate < 5; replicate++) {
				for (const phase of ["A1", "B", "A2"]) {
					const checkout = resolve(
						phase === "B" ? modified : baseline,
					);
					const resultPath = join(scratch, "worker.json");
					const child = spawnSync(
						process.execPath,
						[
							fileURLToPath(import.meta.url),
							"--worker",
							checkout,
							String(count),
							resultPath,
							String(selectedCount),
						],
						{ encoding: "utf8", timeout: 180000 },
					);
					if (child.status !== 0)
						throw Error(
							`Worker failed: ${child.stderr}\n${child.stdout}`,
						);
					runs.push({
						phase,
						replicate,
						...JSON.parse(await readFile(resultPath, "utf8")),
					});
					process.stderr.write(
						`${count}/${selectedCount} ${replicate} ${phase} complete\n`,
					);
				}
			}
		}
		const summary = [];
		for (const { count, selectedCount } of fixtures)
			for (const phase of ["A1", "B", "A2"]) {
				const selected = runs.filter(
					(r) =>
						r.count === count &&
						r.selectedCount === selectedCount &&
						r.phase === phase,
				);
				const row = {
					count,
					selectedCount,
					phase,
					processes: selected.length,
				};
				for (const kind of [
					"warm",
					"releasedCache",
					"insertSamples",
					"upsertSamples",
				])
					for (const metric of ["wallMs", "cpuMs"])
						row[`${kind}_${metric}`] = stats(
							selected.flatMap((r) =>
								r[kind].map((s) => s[metric]),
							),
						);
				for (const metric of ["peakRssKiB", "indexBytes"])
					row[metric] = stats(selected.map((r) => r[metric]));
				row.migrationWallMs = stats(
					selected.map((r) => r.migration.wallMs),
				);
				summary.push(row);
			}
		for (const { count, selectedCount } of fixtures) {
			const selected = runs.filter(
				(r) => r.count === count && r.selectedCount === selectedCount,
			);
			if (new Set(selected.map((r) => r.rowsSha256)).size !== 1)
				throw Error("Full returned rows differ across A/B/A workers");
		}
		const result = {
			runnerSha256: digest(
				await readFile(fileURLToPath(import.meta.url)),
			),
			modifiedSha: execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: resolve(modified),
				encoding: "utf8",
			}).trim(),
			storage:
				"in-memory; first operation in each fresh worker and warmed/cache-release operations; no cold disk measurement",
			scope: "synthetic ensemble SQLite workload through actual compiled db adapter and captured compiled pipeline query; not live daemon/NFS",
			baselineSha: execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: resolve(baseline),
				encoding: "utf8",
			}).trim(),
			runtime: {
				node: process.version,
				npm: execFileSync("npm", ["--version"], {
					encoding: "utf8",
				}).trim(),
				os: os.type(),
				release: os.release(),
				arch: os.arch(),
				cpu: os.cpus()[0].model,
				totalMemory: os.totalmem(),
			},
			fixture: `deterministic sequential rows, paired alternate-title memberships, ${fixtures.map((f) => f.selectedCount).join("/")} matching rows; no random seed`,
			summary,
			runs,
		};
		await writeFile(
			resolve(output),
			JSON.stringify(result, null, 2) + "\n",
		);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}
