// Explicitly synthetic disposable-volume seed for functional Docker smoke only.
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
if (
	process.env.SYNTHETIC_SMOKE !== "1" ||
	process.env.SNAPSHOT_IS_DISPOSABLE !== "1"
)
	throw new Error("Disposable synthetic smoke flags required");
if (existsSync("/snapshot/cross-seed.db") || existsSync("/media/episode.mkv"))
	throw new Error("Refuse existing snapshot/media fixture");
process.env.CONFIG_DIR = "/snapshot";
const root =
	process.env.COMPILED_CHECKOUT ?? "/opt/root-performance/dependencies";
const load = (name) =>
	import("file://" + join(root, "cross-seed/dist", name + ".js"));
const { db } = await load("db");
const config = await load("configuration");
config.createAppDirHierarchy();
const logging = await load("logger");
logging.initializeLogger({ verbose: false });
logging.logger.silent = true;
const { setRuntimeConfig } = await load("runtimeConfig");
setRuntimeConfig({
	...config.getDefaultRuntimeConfig(),
	dataDirs: ["/media"],
	seasonFromEpisodes: 1,
	useClientTorrents: false,
});
await db.migrate.latest();
const hash = "1".padStart(40, "0");
await db("data").insert({
	path: "/media/episode.mkv",
	title: "Smoke Show S01E01",
});
await db("ensemble").insert({
	client_host: "fixture",
	info_hash: hash,
	path: "/media/episode.mkv",
	ensemble: "Smoke Show S01",
	element: "1",
});
await db("client_searchee").insert({
	client_host: "fixture",
	info_hash: hash,
	name: "Smoke.Show.S01E01.mkv",
	title: "Smoke Show S01E01",
	files: JSON.stringify([
		{ name: "episode.mkv", path: "episode.mkv", length: 4096 },
	]),
	length: 4096,
	save_path: "/media",
	category: "fixture",
	tags: "[]",
	trackers: "[]",
});
await db.destroy();
mkdirSync("/media", { recursive: true });
writeFileSync("/media/episode.mkv", Buffer.alloc(4096));
writeFileSync(
	"/snapshot/benchmark-config.json",
	JSON.stringify({
		dataDirs: ["/media"],
		mediaSentinels: ["/media/episode.mkv"],
		seasonFromEpisodes: 1,
		clients: [
			{
				clientHost: "fixture",
				sourceLocator: "http://fixture-original.invalid",
			},
		],
	}),
	{ mode: 0o600 },
);
