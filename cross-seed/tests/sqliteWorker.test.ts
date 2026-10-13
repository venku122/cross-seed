import { afterEach, expect, it } from "vitest";
import { SqliteWorkerConnection } from "../src/sqliteWorker.js";
let connection: SqliteWorkerConnection | undefined;
afterEach(async () => {
	await connection?.close();
});
it("owns one connection across temporary staging and atomic rollback", async () => {
	connection = await SqliteWorkerConnection.open(":memory:");
	await connection.execute(
		"CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT)",
		[],
		false,
	);
	await connection.execute("CREATE TEMP TABLE stage (value TEXT)", [], false);
	await connection.execute("INSERT INTO stage VALUES (?)", ["staged"], false);
	await connection.execute("BEGIN", [], false);
	await connection.execute(
		"INSERT INTO items(value) SELECT value FROM stage",
		[],
		false,
	);
	await connection.execute("ROLLBACK", [], false);
	expect(await connection.execute("SELECT * FROM items", [], true)).toEqual(
		[],
	);
	expect(await connection.execute("SELECT * FROM stage", [], true)).toEqual([
		{ value: "staged" },
	]);
});
it("returns query errors without poisoning the connection", async () => {
	connection = await SqliteWorkerConnection.open(":memory:");
	await expect(
		connection.execute("SELECT * FROM absent", [], true),
	).rejects.toThrow(/no such table/);
	expect(await connection.execute("SELECT ? AS value", [true], true)).toEqual(
		[{ value: 1 }],
	);
});
it("allows timers to run while SQLite executes a large query", async () => {
	connection = await SqliteWorkerConnection.open(":memory:");
	let ticks = 0;
	const timer = setInterval(() => ticks++, 1);
	try {
		await connection.execute(
			"WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2000000) SELECT sum(x) AS n FROM n",
			[],
			true,
		);
		expect(ticks).toBeGreaterThan(5);
	} finally {
		clearInterval(timer);
	}
});
it("rejects requests after close rather than leaving them pending", async () => {
	connection = await SqliteWorkerConnection.open(":memory:");
	await connection.close();
	await expect(connection.execute("SELECT 1", [], true)).rejects.toThrow(
		/closed/,
	);
});

it("keeps Knex transaction and TEMP ownership on one worker while queuing other callers", async () => {
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const directory = await mkdtemp(join(tmpdir(), "sqlite-worker-adapter-"));
	const previousConfig = process.env.CONFIG_DIR;
	const previousWorker = process.env.CROSS_SEED_SQLITE_WORKER;
	process.env.CONFIG_DIR = directory;
	process.env.CROSS_SEED_SQLITE_WORKER = "1";
	const { db } = await import("../src/db.js");
	(
		db.client as { connectionSettings: { filename: string } }
	).connectionSettings.filename = ":memory:";
	try {
		await db.migrate.latest();
		await db.raw("CREATE TEMP TABLE ownership_stage (value TEXT)");
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const rollback = db
			.transaction(async (trx) => {
				await trx("ownership_stage").insert({ value: "uncommitted" });
				entered();
				await gate;
				throw new Error("rollback fixture");
			})
			.catch((error) => error as Error);
		await ready;
		let readFinished = false;
		const outside = db<{ value: string }>("ownership_stage")
			.select("value")
			.then((rows) => {
				readFinished = true;
				return rows;
			});
		await new Promise((resolve) => setImmediate(resolve));
		expect(readFinished).toBe(false);
		release();
		expect((await rollback).message).toBe("rollback fixture");
		expect(await outside).toEqual([]);
		await db("ownership_stage").insert({ value: "committed" });
		expect(await db("ownership_stage")).toEqual([{ value: "committed" }]);
	} finally {
		await db.destroy();
		if (previousConfig === undefined) delete process.env.CONFIG_DIR;
		else process.env.CONFIG_DIR = previousConfig;
		if (previousWorker === undefined)
			delete process.env.CROSS_SEED_SQLITE_WORKER;
		else process.env.CROSS_SEED_SQLITE_WORKER = previousWorker;
		await rm(directory, { recursive: true, force: true });
	}
});
