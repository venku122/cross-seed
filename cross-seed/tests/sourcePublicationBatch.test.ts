import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

const root = await mkdtemp(join(tmpdir(), "cross-seed-bulk-publication-"));
process.env.CONFIG_DIR = root;
const { db } = await import("../src/db.js");
const { createAppDirHierarchy } = await import("../src/configuration.js");
const { ensureSourceNamespace, resolveSourceOrigin, replaceSourcePublication } =
	await import("../src/sourceStore.js");
const { replaceSourcePublicationBatch } =
	await import("../src/sourcePublicationBatch.js");
beforeAll(async () => {
	createAppDirHierarchy();
	await db.migrate.latest();
});
afterAll(async () => {
	await db.destroy();
	await rm(root, { recursive: true, force: true });
});

it("rolls back every bulk origin and membership if any expected revision is stale", async () => {
	const ns = await ensureSourceNamespace(db, "client", "bulk-cas");
	const origins = await Promise.all(
		["a", "b"].map((key) => resolveSourceOrigin(db, ns, key)),
	);
	for (const origin of origins)
		await replaceSourcePublication(db, {
			originId: origin.id,
			expectedRevision: 0,
			revision: 1,
			metadata: { name: origin.source_key },
			status: "verified",
			memberships: [
				{
					path: "/old/" + origin.source_key,
					ensemble: "old",
					element: 1,
				},
			],
		});
	const before = await db("ensemble_membership")
		.select("*")
		.orderBy("origin_id");
	await expect(
		db.transaction((trx) =>
			replaceSourcePublicationBatch(
				trx,
				origins.map((origin, i) => ({
					originId: origin.id,
					expectedRevision: i === 0 ? 1 : 0,
					revision: 2,
					metadata: { name: "new" },
					status: "verified",
					memberships: [
						{ path: "/new", ensemble: "new", element: 1 },
					],
				})),
			),
		),
	).rejects.toThrow("revision conflict");
	expect(
		await db("source_origin")
			.whereIn(
				"id",
				origins.map((o) => o.id),
			)
			.select("revision"),
	).toEqual([{ revision: 1 }, { revision: 1 }]);
	expect(
		await db("ensemble_membership").select("*").orderBy("origin_id"),
	).toEqual(before);
});

it("retains normalized tuple orders and shares paths without deleting another owner", async () => {
	const ns = await ensureSourceNamespace(db, "client", "bulk-order");
	const a = await resolveSourceOrigin(db, ns, "a");
	const b = await resolveSourceOrigin(db, ns, "b");
	await replaceSourcePublication(db, {
		originId: a.id,
		expectedRevision: 0,
		revision: 1,
		metadata: {},
		status: "verified",
		memberships: [
			{ path: "/shared", ensemble: "one", element: 1 },
			{ path: "/shared", ensemble: "one", element: "1" },
		],
	});
	await replaceSourcePublication(db, {
		originId: b.id,
		expectedRevision: 0,
		revision: 1,
		metadata: {},
		status: "verified",
		memberships: [{ path: "/shared", ensemble: "one", element: 1 }],
	});
	const before = await db("ensemble_membership")
		.where("origin_id", a.id)
		.select("*")
		.orderBy("element");
	await db.transaction((trx) =>
		replaceSourcePublicationBatch(trx, [
			{
				originId: a.id,
				expectedRevision: 1,
				revision: 2,
				metadata: {},
				status: "verified",
				memberships: [
					{ path: "/shared", ensemble: "one", element: 1 },
					{ path: "/shared", ensemble: "one", element: "1" },
					{ path: "/added", ensemble: "two", element: 2 },
				],
			},
		]),
	);
	expect(
		await db("ensemble_membership")
			.where({ origin_id: a.id, ensemble: "one" })
			.select("*")
			.orderBy("element"),
	).toEqual(before);
	expect(
		await db("ensemble_membership").where("origin_id", b.id),
	).toHaveLength(1);
	expect(await db("physical_path").where("path", "/shared")).toHaveLength(1);
});
