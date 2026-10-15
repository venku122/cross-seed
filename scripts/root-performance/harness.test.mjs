import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { publish, fixtureFileCount } from "./privacy.mjs";
const child = (name, args = []) =>
	fork(new URL(name, import.meta.url), args, {
		stdio: ["ignore", "ignore", "inherit", "ipc"],
	});
test("aggregate publication drops private identity and arbitrary nested fields", () => {
	const output = publish({
		wallMs: { p99: 2, raw: [1, 2], path: "/private/name" },
		sourceIdentities: { hash: "secret" },
		sql: { calls: 3, firstPathQuery: { bindings: ["secret"] } },
		cpuUs: { user: 1, system: 2 },
	});
	assert.deepEqual(output, {
		wallMs: { p99: 2, raw: [1, 2] },
		sql: { calls: 3 },
		cpuUs: { user: 1, system: 2 },
	});
});
test("source-shaped file counts include rare oversized sources", () => {
	const counts = Array.from({ length: 8194 }, (_, i) =>
		fixtureFileCount(i, "observed"),
	);
	assert.equal(counts.filter((n) => n === 1).length, 4971);
	assert.equal(counts.filter((n) => n > 10000).length, 2);
	assert.equal(counts.filter((n) => n >= 25 && n <= 100).length, 292);
});
test("fake qB is external, read-only and supports actual catalog/detail HTTP", async () => {
	const process = child("./fake-qb.mjs", ["2", "observed", "1"]);
	try {
		const [ready] = await once(process, "message");
		const response = await fetch(`${ready.origin}/api/v2/torrents/info`, {
			method: "POST",
			body: "includeFiles=true&includeTrackers=true",
		});
		const catalog = await response.json();
		assert.equal(catalog.length, 2);
		assert.equal(catalog[0].files.length, 1);
		assert.equal(
			(
				await fetch(`${ready.origin}/api/v2/torrents/delete`, {
					method: "POST",
				})
			).status,
			405,
		);
	} finally {
		process.kill();
		await once(process, "exit");
	}
});
test("open-loop load records active attempts, lag, failures and drain time", async () => {
	const server = createServer((_req, res) =>
		setTimeout(() => res.end("OK"), 70),
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const process = child("./loadgen.mjs", [
		`http://127.0.0.1:${server.address().port}/api/ping`,
		"100",
		"25",
	]);
	try {
		await once(process, "message");
		process.send({ type: "begin" });
		await once(process, "message");
		await new Promise((resolve) => setTimeout(resolve, 110));
		const result = once(process, "message");
		process.send({ type: "stop" });
		const [summary] = await result;
		assert.ok(summary.attempts >= 8);
		assert.equal(
			summary.completed + summary.timeouts + summary.errors,
			summary.attempts,
		);
		assert.equal(summary.samples.length, summary.attempts);
		assert.ok(summary.timeouts >= 1);
		assert.ok(summary.activeWindowMs >= 90);
		assert.ok(
			summary.samples.every(
				(s) => s.scheduledMs < summary.activeWindowMs,
			),
		);
	} finally {
		process.kill();
		await once(process, "exit");
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
});

test("bridge excludes catalog encode/loadgen spawn and uses file DB", async () => {
	const { readFile } = await import("node:fs/promises");
	const { adaptWorker } = await import("./adapt-worker.mjs");
	const original = await readFile(
		new URL("../benchmarks/combined-cleanup.mjs", import.meta.url),
		"utf8",
	);
	const source = adaptWorker(original);
	assert.ok(!source.includes("JSON.stringify(catalog)"));
	assert.ok(!source.includes("const ping = fork("));
	assert.ok(source.includes('join(configDir,"benchmark.db")'));
	assert.ok(
		source.indexOf('await control("stop")') <
			source.indexOf("while (probePending)"),
	);
	assert.throws(
		() =>
			adaptWorker(
				original.replace("const ping = fork(", "const ping2 = fork("),
			),
		/anchor/,
	);
});

test("external control server coordinates generator without daemon child spawn", async () => {
	const server = createServer((_req, res) => res.end("OK"));
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const process = child("./control.mjs");
	try {
		const [ready] = await once(process, "message");
		const command = async (type, body = {}) =>
			(
				await fetch(ready.origin + "/" + type, {
					method: "POST",
					body: JSON.stringify(body),
				})
			).json();
		assert.equal(
			(
				await command("arm", {
					url: `http://127.0.0.1:${server.address().port}/api/ping`,
				})
			).type,
			"ready",
		);
		assert.equal((await command("begin")).type, "begun");
		await new Promise((resolve) => setTimeout(resolve, 50));
		const result = await command("stop");
		assert.equal(
			result.attempts,
			Math.ceil((result.activeWindowMs * result.rate) / 1000),
		);
		assert.equal(
			result.attempts,
			result.completed + result.errors + result.timeouts,
		);
	} finally {
		process.kill();
		await once(process, "exit");
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
});

test("HTTP publication validates numeric values and fixed outcome enums", async () => {
	const { publishHttp } = await import("./privacy.mjs");
	assert.deepEqual(
		publishHttp({
			attempts: 1,
			rate: "private source name",
			samples: [
				{
					scheduledMs: 0,
					latencyMs: "/private/path",
					outcome: "private error",
					hash: "secret",
				},
			],
		}),
		{ attempts: 1, samples: [{ scheduledMs: 0, outcome: "error" }] },
	);
});

test("transformed worker syntax and owned-store fixture migration are valid", async () => {
	const { readFile } = await import("node:fs/promises");
	const { execFileSync } = await import("node:child_process");
	const { adaptWorker } = await import("./adapt-worker.mjs");
	const source = adaptWorker(
		await readFile(
			new URL("../benchmarks/combined-cleanup.mjs", import.meta.url),
			"utf8",
		),
	);
	execFileSync(process.execPath, ["--check", "--input-type=module"], {
		input: source,
	});
	assert.ok(
		source.indexOf("await migration.default.up(db)") <
			source.indexOf("const cpuStart = process.cpuUsage()"),
	);
	assert.ok(source.includes("await ownedQuery(db)"));
	assert.ok(source.includes("legacyBefore!==legacyAfter"));
});

test("repaired data visibility excludes hidden owners, preserves shared visible paths and null legacy rows", async () => {
	const { DatabaseSync } = await import("node:sqlite");
	const { VISIBLE_DATA_SQL } = await import("./adapt-worker.mjs");
	const db = new DatabaseSync(":memory:");
	try {
		db.exec(
			"CREATE TABLE data(path TEXT,title TEXT); CREATE TABLE source_namespace(id TEXT,enabled INTEGER); CREATE TABLE source_origin(id TEXT,namespace_id TEXT,state TEXT,metadata TEXT);",
		);
		db.exec(
			"INSERT INTO source_namespace VALUES ('enabled',1),('disabled',0)",
		);
		const data = db.prepare("INSERT INTO data VALUES (?,?)");
		const origin = db.prepare("INSERT INTO source_origin VALUES (?,?,?,?)");
		for (const [path, state, namespace] of [
			["visible", "verified", "enabled"],
			["missing", "unavailable", "enabled"],
			["removed", "removed", "enabled"],
			["old", "superseded", "enabled"],
			["disabled", "verified", "disabled"],
			["shared", "unavailable", "enabled"],
			["unowned", null, null],
		]) {
			data.run(path, "Synthetic fixture");
			if (state)
				origin.run(path, namespace, state, JSON.stringify({ path }));
		}
		data.run(null, "Synthetic fixture");
		origin.run(
			"shared-live",
			"enabled",
			"verified",
			JSON.stringify({ path: "shared" }),
		);
		assert.deepEqual(
			db
				.prepare(VISIBLE_DATA_SQL + " ORDER BY path")
				.all()
				.map((row) => row.path),
			[null, "shared", "unowned", "visible"],
		);
		assert.equal(db.prepare("SELECT count(*) n FROM data").get().n, 8);
	} finally {
		db.close();
	}
});

test("data visibility transformation requires exactly one matching original anchor", async () => {
	const { readFile } = await import("node:fs/promises");
	const { adaptWorker } = await import("./adapt-worker.mjs");
	const original = await readFile(
		new URL("../benchmarks/combined-cleanup.mjs", import.meta.url),
		"utf8",
	);
	const anchors = [
		'for (const row of await db("data").select("path", "title").orderBy("path"))',
		'const remainingData = await db("data").count({ n: "*" }).first();',
	];
	for (const anchor of anchors) {
		assert.throws(
			() => adaptWorker(original.replace(anchor, "changed anchor")),
			/anchor changed/,
		);
		assert.throws(
			() => adaptWorker(original + "\n" + anchor),
			/anchor changed/,
		);
	}
	const source = adaptWorker(original);
	assert.ok(source.includes('visibleData().select("path", "title")'));
	assert.ok(source.includes('visibleData().count({ n: "*" })'));
	assert.ok(
		source.includes(
			"rawDataRows, rawLegacyMembershipRows, rawOwnedMembershipRows",
		),
	);
});

test("profiling transformation brackets actual job and labels legacy plan explicitly", async () => {
	const { readFile } = await import("node:fs/promises");
	const { adaptWorker } = await import("./adapt-worker.mjs");
	const original = await readFile(
		new URL("../benchmarks/combined-cleanup.mjs", import.meta.url),
		"utf8",
	);
	const source = adaptWorker(original);
	assert.ok(
		source.indexOf("activeProfiler.begin()") <
			source.indexOf("const cpuStart = process.cpuUsage()"),
	);
	assert.ok(
		source.indexOf("await activeProfiler.end()") >
			source.indexOf("const cpu = process.cpuUsage(cpuStart)"),
	);
	assert.ok(
		source.indexOf("await activeProfiler.end()") <
			source.indexOf("const actualPathPlan ="),
	);
	assert.ok(source.includes("legacyReferenceMergePlan: plans"));
	assert.ok(!source.includes("referenceMergePlan: plans"));
	for (const anchor of [
		"const pre = process.memoryUsage();",
		"const cpuStart = process.cpuUsage();",
		"referenceMergePlan: plans,",
	])
		assert.throws(
			() => adaptWorker(original.replace(anchor, "changed")),
			/anchor changed/,
		);
});

test("candidate worker is enabled only for B and inherited settings cannot affect baseline", async () => {
	const { workerEnvironment, workerDockerFlags } =
		await import("./worker-mode.mjs");
	for (const enabled of [false, true])
		for (const phase of ["A1", "B", "A2"]) {
			const env = workerEnvironment(
				{ CROSS_SEED_SQLITE_WORKER: "1", SAFE_SETTING: "x" },
				phase,
				enabled,
			);
			assert.equal(
				env.CROSS_SEED_SQLITE_WORKER,
				enabled && phase === "B" ? "1" : undefined,
			);
			assert.equal(env.SAFE_SETTING, "x");
			assert.deepEqual(workerDockerFlags(phase, enabled), [
				"--env",
				`CROSS_SEED_SQLITE_WORKER=${enabled && phase === "B" ? "1" : ""}`,
			]);
		}
	assert.throws(() => workerEnvironment({}, "other", true), /Invalid/);
});

test("the repaired bridge compares compatibility metadata while retaining strict data and membership gates", async () => {
	const { readFile } = await import("node:fs/promises");
	const { adaptWorker } = await import("./adapt-worker.mjs");
	const original = await readFile(
		new URL("../benchmarks/combined-cleanup.mjs", import.meta.url),
		"utf8",
	);
	const generated = adaptWorker(original);
	assert.ok(generated.includes("key !== 'source_namespace_id'"));
	const runner = await readFile(
		new URL("./run-aba.mjs", import.meta.url),
		"utf8",
	);
	assert.ok(runner.includes("result.dataRowsMatch"));
	assert.ok(runner.includes("result.cacheRowsMatch"));
});
