import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
const directory = await mkdtemp(join(tmpdir(), "settings-source-"));
process.env.CONFIG_DIR = directory;
const { db } = await import("../src/db.js");
const { getDefaultRuntimeConfig, createAppDirHierarchy } =
	await import("../src/configuration.js");
const { setRuntimeConfig } = await import("../src/runtimeConfig.js");
const { initializeLogger } = await import("../src/logger.js");
const { settingsRouter } = await import("../src/trpc/routers/settings.js");
const {
	ensureSourceNamespace,
	resolveSourceOrigin,
	replaceSourcePublication,
	sourceMembershipQuery,
} = await import("../src/sourceStore.js");
const caller = settingsRouter.createCaller({
	user: { id: 1, username: "fixture" },
} as import("../src/trpc/index.js").Context);
afterAll(async () => {
	await db.destroy();
	await rm(directory, { recursive: true, force: true });
});
it("hides retained ensemble ownership immediately after a settings source is disabled", async () => {
	createAppDirHierarchy();
	initializeLogger({ verbose: false });
	await db.migrate.latest();
	setRuntimeConfig({
		...getDefaultRuntimeConfig(),
		dataDirs: ["/synthetic/root"],
		torrentClients: [],
		torrentDir: undefined,
	});
	const namespace = await ensureSourceNamespace(
		db,
		"data-root",
		"/synthetic/root",
	);
	const origin = await resolveSourceOrigin(db, namespace, "episode");
	await replaceSourcePublication(db, {
		originId: origin.id,
		expectedRevision: 0,
		revision: 1,
		status: "verified",
		metadata: { path: "/synthetic/root/episode" },
		memberships: [
			{
				path: "/synthetic/root/episode",
				ensemble: "fixture.S1",
				element: "1",
			},
		],
	});
	expect(await sourceMembershipQuery(db)).toHaveLength(1);
	await caller.save({ dataDirs: [], torrentClients: [] });
	expect(await sourceMembershipQuery(db)).toHaveLength(0);
	expect(await db("ensemble_membership")).toHaveLength(1);
	await caller.save({ dataDirs: ["/synthetic/root"], torrentClients: [] });
	expect(await sourceMembershipQuery(db)).toHaveLength(1);
});
it("hides a migrated named legacy membership when its client is disabled without erasing history", async () => {
	const path = "/synthetic/legacy-episode";
	await db("ensemble").insert({
		client_host: "fixture.invalid/qb",
		info_hash: "legacy-hash",
		path,
		ensemble: "legacy.S1",
		element: "1",
	});
	await (
		await import("../src/migrations/19-source-ownership.js")
	).default.up(db);
	const active = {
		dataDirs: [],
		torrentClients: ["qbittorrent:http://fixture.invalid/qb"],
		useClientTorrents: true,
	};
	await caller.save(active);
	expect(await sourceMembershipQuery(db).where("p.path", path)).toHaveLength(
		1,
	);
	await caller.save({
		...active,
		torrentClients: [],
		useClientTorrents: false,
	});
	expect(await sourceMembershipQuery(db).where("p.path", path)).toHaveLength(
		0,
	);
	const stored = await db<{
		id: string;
		state: string;
		namespace_id: string;
	}>("source_origin")
		.where({ namespace_id: "legacy-unknown" })
		.whereRaw("json_extract(metadata,'$.path')=?", [path])
		.first();
	expect(stored!.state).toBe("legacy-unknown");
	expect(
		await db("ensemble_membership").where({ origin_id: stored!.id }),
	).toHaveLength(1);
	await caller.save(active);
	expect(await sourceMembershipQuery(db).where("p.path", path)).toHaveLength(
		1,
	);
});
