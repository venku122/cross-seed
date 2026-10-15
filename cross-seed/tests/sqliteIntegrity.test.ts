import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
const directory = await mkdtemp(join(tmpdir(), "sqlite-integrity-"));
process.env.CONFIG_DIR = directory;
const { db } = await import("../src/db.js");
afterAll(async () => {
	await db.destroy();
	await rm(directory, { recursive: true, force: true });
});
it("enforces source foreign keys on the application's default connection", async () => {
	await db.migrate.latest();
	expect(await db.raw("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }]);
	await expect(
		db("source_origin").insert({
			id: "bad",
			namespace_id: "missing",
			source_key: "fixture",
			revision: 0,
			state: "verified",
			metadata: "{}",
		}),
	).rejects.toThrow(/FOREIGN KEY/);
});

it("returns PRAGMA table metadata through the application's connection", async () => {
	expect(await db.schema.hasColumn("source_origin", "visible")).toBe(true);
	expect(
		await db.schema.hasColumn("client_searchee", "source_namespace_id"),
	).toBe(true);
	expect(
		await db.schema.hasColumn("source_origin", "absent_fixture_column"),
	).toBe(false);
});
