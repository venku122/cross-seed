import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientSearcheeRow, SearcheeClient } from "../src/searchee.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const root = await mkdtemp(join(tmpdir(), "cross-seed-cache-tests-"));
process.env.CONFIG_DIR = root;
const { db } = await import("../src/db.js");
const { cachedClientTorrents } = await import("../src/clients/clientCache.js");
const { clientSearcheeModified } =
	await import("../src/clients/TorrentClient.js");
const { updateSearcheeClientDB } = await import("../src/searchee.js");
const { createAppDirHierarchy } = await import("../src/configuration.js");
const hashes = Array.from({ length: 1001 }, (_, i) => String(i));
const queries: { sql: string; bindings?: readonly unknown[] }[] = [];

describe.sequential("bounded client cache reads", () => {
	beforeAll(async () => {
		createAppDirHierarchy();
		await db.migrate.latest();
		for (let offset = 0; offset < hashes.length; offset += 100) {
			await db("client_searchee").insert(
				hashes.slice(offset, offset + 100).map((info_hash) => ({
					client_host: "fixture",
					info_hash,
					name: "Fixture",
					title: "Fixture",
					files: "[]",
					length: 0,
					save_path: "/synthetic",
					category: null,
					tags: null,
					trackers: "[]",
				})),
			);
		}
		await db("client_searchee").insert({
			client_host: "other",
			info_hash: "0",
			name: "Different",
			files: "bad JSON",
		});
		db.on(
			"query",
			(query: { sql: string; bindings?: readonly unknown[] }) =>
				queries.push(query),
		);
	});
	afterAll(async () => {
		await db.destroy();
		await rm(root, { recursive: true, force: true });
	});

	it("preserves input order and client isolation across bounded hydration reads", async () => {
		queries.splice(0);
		const output: {
			infoHash: string;
			useCache: boolean;
			dbTorrent?: ClientSearcheeRow;
		}[] = [];
		for await (const entry of cachedClientTorrents(
			hashes.toReversed(),
			"fixture",
			(h) => h,
			(_h, row) =>
				!clientSearcheeModified(
					"fixture",
					row,
					"Fixture",
					"/synthetic",
				),
			true,
		))
			output.push(entry);
		expect(output.map((e) => e.infoHash)).toEqual(hashes.toReversed());
		expect(output.every((e) => e.dbTorrent?.name === "Fixture")).toBe(true);
		expect(queries.filter((q) => q.sql.startsWith("select"))).toHaveLength(
			8,
		);
		expect(queries.every((q) => (q.bindings?.length ?? 0) <= 501)).toBe(
			true,
		);
	});

	it("never fetches file JSON when cached results are omitted", async () => {
		queries.splice(0);
		let length = 0;
		for await (const entry of cachedClientTorrents(
			hashes,
			"fixture",
			(h) => h,
			() => true,
			false,
		)) {
			expect(entry.dbTorrent).toBeUndefined();
			length++;
		}
		expect(length).toBe(1001);
		expect(queries).toHaveLength(3);
		expect(
			queries.every(
				(q) => !q.sql.includes("files") && !q.sql.includes("select *"),
			),
		).toBe(true);
	});

	it("hydrates only unchanged rows and leaves missing or changed rows for refresh", async () => {
		queries.splice(0);
		const output: {
			infoHash: string;
			useCache: boolean;
			dbTorrent?: ClientSearcheeRow;
		}[] = [];
		for await (const entry of cachedClientTorrents(
			["missing", "1", "0"],
			"fixture",
			(h) => h,
			(h, row) =>
				!clientSearcheeModified(
					"fixture",
					row,
					h === "1" ? "Renamed" : "Fixture",
					"/synthetic",
				),
			true,
		))
			output.push(entry);
		expect(output.map((e) => e.useCache)).toEqual([false, false, true]);
		expect(output.map((e) => e.dbTorrent?.info_hash)).toEqual([
			undefined,
			undefined,
			"0",
		]);
		expect(
			queries.find((q) => q.sql.includes("select *"))?.bindings,
		).toEqual(["fixture", "0"]);
	});
	it("limits serialized hydration to one oversized row at a time", async () => {
		const large = JSON.stringify([
			{ name: "oversized", path: "x".repeat(1_100_000), length: 1 },
		]);
		for (const info_hash of ["large1", "large2", "large3"])
			await db("client_searchee").insert({
				client_host: "fixture",
				info_hash,
				name: "Large",
				files: large,
			});
		queries.splice(0);
		let count = 0;
		for await (const entry of cachedClientTorrents(
			["large1", "large2", "large3"],
			"fixture",
			(h) => h,
			() => true,
			true,
		)) {
			expect(entry.dbTorrent?.files).toHaveLength(large.length);
			count++;
		}
		expect(count).toBe(3);
		expect(queries.filter((q) => q.sql.includes("select *"))).toHaveLength(
			3,
		);
	});
	it("revalidates cache metadata changed between check and hydration", async () => {
		let update: Promise<number> | undefined;
		const flags: boolean[] = [];
		const names: (string | undefined)[] = [];
		for await (const entry of cachedClientTorrents(
			["1"],
			"fixture",
			(h) => h,
			(_h, row) => {
				update ??= db("client_searchee")
					.where({ client_host: "fixture", info_hash: "1" })
					.update({ name: "Concurrent" })
					.then((count) => count);
				return !clientSearcheeModified(
					"fixture",
					row,
					"Fixture",
					"/synthetic",
				);
			},
			true,
		)) {
			flags.push(entry.useCache);
			names.push(entry.dbTorrent?.name);
		}
		await update;
		expect(names).toEqual(["Concurrent"]);
		expect(flags).toEqual([false]);
	});
	it("bounds hydration when file metadata grows after the lightweight read", async () => {
		const growing = ["growing1", "growing2", "growing3"];
		const large = JSON.stringify([
			{ name: "oversized", path: "x".repeat(1_100_000), length: 1 },
		]);
		for (const info_hash of growing)
			await db("client_searchee").insert({
				client_host: "fixture",
				info_hash,
				name: "Growing",
				files: "[]",
			});
		let update: Promise<number> | undefined;
		let largestRead = 0,
			count = 0;
		const observe = (rows: ClientSearcheeRow[], query: { sql: string }) => {
			if (query.sql.includes("select *") && Array.isArray(rows))
				largestRead = Math.max(
					largestRead,
					rows.reduce(
						(sum, row) => sum + Buffer.byteLength(row.files),
						0,
					),
				);
		};
		db.on("query-response", observe);
		try {
			for await (const entry of cachedClientTorrents(
				growing,
				"fixture",
				(h) => h,
				() => {
					update ??= db("client_searchee")
						.where("client_host", "fixture")
						.whereIn("info_hash", growing)
						.update({ files: large })
						.then((n) => n);
					return true;
				},
				true,
			)) {
				expect(entry.dbTorrent?.files).toBe(large);
				count++;
			}
			await update;
			expect(count).toBe(3);
			expect(largestRead).toBeLessThanOrEqual(Buffer.byteLength(large));
		} finally {
			db.removeListener("query-response", observe);
		}
	});
	it("writes the first cache batch before serializing the full refresh", async () => {
		const searchees: SearcheeClient[] = Array.from(
			{ length: 250 },
			(_, i) => ({
				clientHost: "serialization",
				infoHash: String(i).padStart(40, "0"),
				name: `Fixture.${i}`,
				title: `Fixture.${i}`,
				savePath: "/synthetic",
				length: 1,
				files: [{ name: `file${i}`, path: `file${i}`, length: 1 }],
				trackers: ["tracker.invalid"],
			}),
		);
		const knownFiles = new Set<unknown>(searchees.map((s) => s.files));
		const stringify = JSON.stringify;
		let serialized = 0;
		const writes: number[] = [];
		const observe = (query: { sql: string }) => {
			if (
				query.sql.startsWith("insert into") &&
				query.sql.includes("client_searchee")
			)
				writes.push(serialized);
		};
		const spy = vi
			.spyOn(JSON, "stringify")
			.mockImplementation((value, replacer, space) => {
				if (knownFiles.has(value)) serialized++;
				return stringify(value, replacer, space);
			});
		db.on("query", observe);
		try {
			await updateSearcheeClientDB(
				"serialization",
				searchees,
				new Set(searchees.map((s) => s.infoHash)),
			);
			expect(writes).toEqual([100, 200, 250]);
			expect(
				await db("client_searchee")
					.where("client_host", "serialization")
					.select("info_hash"),
			).toHaveLength(250);
		} finally {
			spy.mockRestore();
			db.removeListener("query", observe);
		}
	});
});
